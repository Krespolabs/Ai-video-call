// api/_lib/x402/scene-capture-processor.js
//
// Scene Capture Video Queue Processor — the autonomous pipeline behind the
// /capture feature. Users upload a video on the /capture page; instead of
// blocking the request on a multi-minute GPU reconstruction, the upload is
// enqueued into `scene_capture_queue` and this processor drains it on the x402
// autonomous loop's schedule:
//
//   pending     → pay $0.01 USDC (x402) for one processing credit, then submit
//                 the video to the LingBot-Map GPU worker (workers/model-video2scene).
//   processing  → poll the worker; when the .ply point cloud is ready, store the
//                 result URL + telemetry back on the queue row.
//
// One scene = one metered x402 payment (at submit). Status polls are free internal
// status checks and never pay. The processor is invoked from the autonomous loop
// via the registry entry's run(ctx) — the loop records every invocation to
// x402_autonomous_log; this module owns the queue + result storage.
//
// Value extracted → stored to:
//   scene_capture_queue.result_url   (the finished .ply point-cloud URL)
//   scene_capture_queue.num_points   (reconstruction point count)
//   scene_capture_queue.frames       (frames fused)
//   x402_autonomous_log.signal_data  (the loop persists the run() outcome's
//                                      signalData — job/result snapshot — here)
//
// Downstream consumer: src/scene-capture.js (the /capture page, pages/capture.html)
// fetches result_url and renders the .ply client-side as a THREE.Points cloud.

import { sql } from '../db.js';
import { env } from '../env.js';
import { logger } from '../usage.js';
import { assertPublicHttpsUrl, SsrfError } from '../ssrf.js';
import { createRegenProvider } from '../../_providers/gcp.js';
import { payX402, bootstrapSolanaContext } from './pay.js';

const log = logger('x402-scene-capture');

// One processing credit = $0.01 USDC = 10_000 atomics (USDC has 6 decimals).
export const SCENE_CAPTURE_CREDIT_SLUG = 'video2scene-processing-credit';
export const SCENE_CAPTURE_PRICE_ATOMIC = 10_000;
// Path of the x402 endpoint that meters a scene-processing credit.
export const SCENE_CAPTURE_ENDPOINT = `/api/x402/asset-download?slug=${SCENE_CAPTURE_CREDIT_SLUG}`;
// Stop retrying a video after this many failed submit/credit attempts.
const MAX_ATTEMPTS = 3;

let schemaReady = false;

// Idempotent schema + catalog setup. The queue table backs the /capture upload
// flow; the paid_assets credit row makes the metering payment resolvable against
// the existing /api/x402/asset-download endpoint without forking it. Payout
// recirculates to the platform wallet (env.X402_PAY_TO_SOLANA) — falls back to
// env inside the endpoint when the column is NULL.
export async function ensureSceneCaptureSchema() {
	if (schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS scene_capture_queue (
			id            bigserial PRIMARY KEY,
			video_url     text NOT NULL,
			params        jsonb NOT NULL DEFAULT '{}'::jsonb,
			status        text NOT NULL DEFAULT 'pending'
			              CHECK (status IN ('pending','submitting','processing','done','failed')),
			job_id        text,
			result_url    text,
			num_points    integer,
			frames        integer,
			bytes         bigint,
			error_msg     text,
			attempts      integer NOT NULL DEFAULT 0,
			tx_signature  text,
			amount_atomic bigint,
			enqueued_by   text,
			created_at    timestamptz NOT NULL DEFAULT now(),
			updated_at    timestamptz NOT NULL DEFAULT now()
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS scene_capture_queue_status_idx
			ON scene_capture_queue (status, created_at)
	`;
	await sql`
		INSERT INTO paid_assets
			(slug, title, description, mime_type, size_bytes, r2_key, price_atomics, creator_payto_solana)
		VALUES
			(${SCENE_CAPTURE_CREDIT_SLUG},
			 'Scene Capture Processing Credit',
			 'One video-to-3D scene reconstruction credit. Meters a single GPU point-cloud job in the three.ws scene-capture pipeline.',
			 'application/json', 0,
			 ${`credits/${SCENE_CAPTURE_CREDIT_SLUG}.json`},
			 ${String(SCENE_CAPTURE_PRICE_ATOMIC)},
			 ${env.X402_PAY_TO_SOLANA || null})
		ON CONFLICT (slug) DO NOTHING
	`;
	schemaReady = true;
}

// Enqueue a user-uploaded video for autonomous reconstruction. Called by the
// /capture upload path; validates the URL up front so a bad row never reaches
// the GPU worker. Returns the queue row id.
export async function enqueueSceneCapture({ videoUrl, params = {}, enqueuedBy = null }) {
	await ensureSceneCaptureSchema();
	const safeUrl = await assertPublicHttpsUrl(String(videoUrl || ''));
	const rows = await sql`
		INSERT INTO scene_capture_queue (video_url, params, enqueued_by)
		VALUES (${safeUrl}, ${JSON.stringify(params || {})}, ${enqueuedBy})
		RETURNING id
	`;
	return rows[0]?.id ?? null;
}

function resolveProvider() {
	try {
		const provider = createRegenProvider();
		return provider.supportsMode('video2scene') ? provider : null;
	} catch {
		return null;
	}
}

// Atomically claim the oldest pending row (marking it 'submitting' so a
// concurrent tick can't grab the same video) — FOR UPDATE SKIP LOCKED.
async function claimPending() {
	const rows = await sql`
		UPDATE scene_capture_queue
		   SET status = 'submitting', attempts = attempts + 1, updated_at = now()
		 WHERE id = (
			 SELECT id FROM scene_capture_queue
			  WHERE status = 'pending'
			  ORDER BY created_at ASC
			  LIMIT 1
			  FOR UPDATE SKIP LOCKED
		 )
		RETURNING *
	`;
	return rows[0] || null;
}

async function claimProcessing() {
	const rows = await sql`
		SELECT * FROM scene_capture_queue
		 WHERE status = 'processing' AND job_id IS NOT NULL
		 ORDER BY updated_at ASC
		 LIMIT 1
	`;
	return rows[0] || null;
}

// Move a claimed-but-unsubmitted row back to a resting state.
async function releaseRow(id, { status, errorMsg = null }) {
	await sql`
		UPDATE scene_capture_queue
		   SET status = ${status}, error_msg = ${errorMsg}, updated_at = now()
		 WHERE id = ${id}
	`;
}

// Process one unit of queue work. Returns the structured outcome the autonomous
// loop records to x402_autonomous_log:
//   { success, amountAtomic, txSig, responseData, signalData, errorMsg, skipped, note }
//
// `success` reflects whether the autonomous x402 call did its job (paid a credit,
// or completed a free status poll). Reconstruction-level failures live on the
// queue row (scene_capture_queue.error_msg), not on the metered call.
export async function runSceneCaptureProcessor(ctx = {}) {
	try {
		await ensureSceneCaptureSchema();
	} catch (err) {
		log.warn('schema_ensure_failed', { message: err?.message });
		return { success: false, amountAtomic: 0, txSig: null, errorMsg: `schema_failed: ${err?.message}`, note: 'schema_failed' };
	}

	const provider = resolveProvider();
	if (!provider) {
		// GPU worker not wired on this deployment — graceful no-op, recorded.
		log.info('video2scene_unconfigured');
		return {
			success: true, skipped: true, amountAtomic: 0, txSig: null,
			note: 'video2scene_unconfigured',
			responseData: { reason: 'GCP_VIDEO2SCENE_URL / GCP_RECONSTRUCTION_KEY not configured' },
		};
	}

	// Prefer draining in-flight jobs (free polls) before paying to submit new ones.
	let processing;
	try { processing = await claimProcessing(); } catch (err) {
		return { success: false, amountAtomic: 0, txSig: null, errorMsg: `db_failed: ${err?.message}`, note: 'db_failed' };
	}
	if (processing) return pollExisting(provider, processing);

	let pending;
	try { pending = await claimPending(); } catch (err) {
		return { success: false, amountAtomic: 0, txSig: null, errorMsg: `db_failed: ${err?.message}`, note: 'db_failed' };
	}
	if (pending) return payAndSubmit(ctx, provider, pending);

	// Nothing to do — still a successful, recorded tick (amount 0).
	return { success: true, amountAtomic: 0, txSig: null, note: 'queue_empty', responseData: { pending: 0, processing: 0 } };
}

async function pollExisting(provider, row) {
	let result;
	try {
		result = await provider.status(row.job_id);
	} catch (err) {
		// Transient worker/network fault — keep the job processing, retry next tick.
		await sql`UPDATE scene_capture_queue SET updated_at = now() WHERE id = ${row.id}`.catch(() => {});
		return { success: true, amountAtomic: 0, txSig: null, note: 'poll_failed_retry', errorMsg: err?.message,
			signalData: { action: 'poll', queue_id: Number(row.id), state: 'error' } };
	}

	if (result.status === 'done') {
		const resultUrl = result.resultPointCloudUrl || null;
		if (!resultUrl) {
			await releaseRow(row.id, { status: 'failed', errorMsg: 'worker reported done with no result URL' });
			return { success: true, amountAtomic: 0, txSig: null, note: 'done_no_result',
				signalData: { action: 'poll', queue_id: Number(row.id), state: 'failed' } };
		}
		await sql`
			UPDATE scene_capture_queue
			   SET status = 'done', result_url = ${resultUrl},
			       num_points = ${result.numPoints ?? null}, frames = ${result.frames ?? null},
			       bytes = ${result.bytes ?? null}, error_msg = NULL, updated_at = now()
			 WHERE id = ${row.id}
		`;
		const signalData = {
			action: 'poll', queue_id: Number(row.id), state: 'done',
			result_url: resultUrl, num_points: result.numPoints ?? null, frames: result.frames ?? null,
		};
		log.info('scene_done', { queue_id: Number(row.id), num_points: result.numPoints ?? null });
		return { success: true, amountAtomic: 0, txSig: null, note: 'completed', responseData: signalData, signalData };
	}

	if (result.status === 'failed') {
		await releaseRow(row.id, { status: 'failed', errorMsg: result.error || 'reconstruction failed' });
		return { success: true, amountAtomic: 0, txSig: null, note: 'reconstruction_failed', errorMsg: result.error || null,
			signalData: { action: 'poll', queue_id: Number(row.id), state: 'failed' } };
	}

	// queued / running — touch and wait for the next tick.
	await sql`UPDATE scene_capture_queue SET updated_at = now() WHERE id = ${row.id}`;
	return { success: true, amountAtomic: 0, txSig: null, note: 'still_processing',
		signalData: { action: 'poll', queue_id: Number(row.id), state: result.status } };
}

async function payAndSubmit(ctx, provider, row) {
	const id = Number(row.id);
	const attempts = Number(row.attempts) || 0;
	const giveUpStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';

	// Defense-in-depth: re-validate the stored URL before handing it to the worker.
	let videoUrl;
	try {
		videoUrl = await assertPublicHttpsUrl(String(row.video_url || ''));
	} catch (err) {
		await releaseRow(id, { status: 'failed', errorMsg: err instanceof SsrfError ? `url_rejected: ${err.message}` : 'invalid_video_url' });
		return { success: false, amountAtomic: 0, txSig: null, note: 'invalid_video_url', errorMsg: err?.message };
	}

	// Resolve the payment context. Reuse the loop's shared per-tick Solana state
	// when present; bootstrap our own when called standalone (manual test).
	let buyer = ctx.buyer, conn = ctx.conn, blockhash = ctx.blockhash, mintInfo = ctx.mintInfo;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			// Wallet not configured — leave the row pending and exit gracefully.
			await releaseRow(id, { status: 'pending', errorMsg: `payer_unconfigured: ${err?.message}` });
			log.info('payer_unconfigured', { queue_id: id, message: err?.message });
			return { success: true, skipped: true, amountAtomic: 0, txSig: null, note: 'payer_unconfigured', errorMsg: err?.message };
		}
	}

	// Step 1 — pay one processing credit via x402.
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	let pay;
	try {
		pay = await payX402({
			url: `${origin}${SCENE_CAPTURE_ENDPOINT}`,
			method: 'GET',
			buyer, conn, blockhash, mintInfo,
			remainingCap: ctx.remainingCap ?? Infinity,
		});
	} catch (err) {
		await releaseRow(id, { status: giveUpStatus, errorMsg: `pay_error: ${err?.message}` });
		return { success: false, amountAtomic: 0, txSig: null, note: 'pay_error', errorMsg: err?.message };
	}

	if (!pay.success) {
		// 402 rejection, cap exceeded, asset mismatch, etc. — don't burn GPU.
		await releaseRow(id, { status: giveUpStatus, errorMsg: `payment_failed: ${pay.errorMsg}` });
		return { success: false, skipped: !!pay.skipped, amountAtomic: pay.amountAtomic || 0, txSig: pay.txSig || null,
			note: 'payment_failed', errorMsg: pay.errorMsg, responseData: pay.responseBody };
	}

	// Step 2 — submit the paid scene to the GPU worker.
	let job;
	try {
		job = await provider.submit({ mode: 'video2scene', sourceUrl: videoUrl, params: row.params || {} });
	} catch (err) {
		// We paid; the submit failed. The credit is spent (recorded), the scene
		// retries next tick. Payment success is what the autonomous loop meters.
		await releaseRow(id, { status: giveUpStatus, errorMsg: `submit_failed: ${err?.message}` });
		log.warn('submit_failed_after_pay', { queue_id: id, tx: pay.txSig, message: err?.message });
		return {
			success: true, amountAtomic: pay.amountAtomic, txSig: pay.txSig,
			note: 'submit_failed_after_pay',
			signalData: { action: 'submit', queue_id: id, state: 'submit_failed', tx_signature: pay.txSig },
			responseData: pay.responseBody,
		};
	}

	await sql`
		UPDATE scene_capture_queue
		   SET status = 'processing', job_id = ${job.extJobId},
		       tx_signature = ${pay.txSig}, amount_atomic = ${pay.amountAtomic},
		       error_msg = NULL, updated_at = now()
		 WHERE id = ${id}
	`;
	const signalData = {
		action: 'submit', queue_id: id, state: 'processing',
		job_id: job.extJobId, eta_seconds: job.eta ?? null, tx_signature: pay.txSig,
	};
	log.info('scene_submitted', { queue_id: id, tx: pay.txSig, amount_usdc: pay.amountAtomic / 1e6 });
	return {
		success: true, amountAtomic: pay.amountAtomic, txSig: pay.txSig,
		note: 'submitted', responseData: signalData, signalData,
	};
}

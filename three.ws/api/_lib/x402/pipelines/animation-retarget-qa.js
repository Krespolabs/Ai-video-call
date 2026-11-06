// api/_lib/x402/pipelines/animation-retarget-qa.js
//
// Animation Retargeting QA — autonomous pipeline (self/012).
//
// On each run it pays to download a representative set of canary animation
// clips — one per rig convention (Mixamo, VRM, Avaturn, Daz, …) — through the
// real paid-delivery path (POST/GET /api/x402/animation-download → 402 paywall →
// R2 presign → animated GLB). Each call is a real on-chain USDC payment from the
// seed wallet at the clip's advertised price ($0.005/clip for the QA canaries).
// The pipeline:
//
//   1. Probes + pays each clip via the shared payX402 client (real x402, never
//      mocked). A clip listed free returns 200 with no 402 and is graded too.
//   2. Fetches the returned short-lived presigned R2 URL and inspects the actual
//      bytes with inspectGlb() — confirming a non-zero, valid binary glTF whose
//      animation track survived. A baked clip that comes back empty, truncated,
//      non-GLB, or with zero animation channels is exactly the regression a
//      glb-canonicalize.js / animation-retarget.js break produces, so the verdict
//      flips to passed:false here before a buyer ever hits it.
//   3. Records a row in x402_autonomous_log for every clip (success or failure),
//      with the parsed QA verdict in value_extracted.
//   4. Upserts the per-clip verdict into animation_qa_results keyed by clip_id so
//      the animation marketplace + ops alerting can read the latest QA state.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js. The per-tick
// loop (api/cron/x402-autonomous-loop.js) hands run() a shared payment context
// (buyer, conn, blockhash, mintInfo, remainingCap); called standalone (manual
// test) it bootstraps its own context via bootstrapSolanaContext().
//
// Canary clips: designate them via env. Each is a stable, listed marketplace
// clip authored from a specific rig type so the sweep exercises every retarget
// path. Either form is accepted (comma-separated):
//   X402_ANIMATION_QA_CLIP_IDS="mixamo=<uuid>,vrm=<uuid>,avaturn=<uuid>,daz=<uuid>"
//   X402_ANIMATION_QA_CLIP_IDS="<uuid>,<uuid>"           // unlabeled rigs
//   X402_ANIMATION_QA_CLIP_ID="<uuid>"                   // single-clip fallback
// Unset → the pipeline is disabled in the registry and never pays.
//
// Downstream consumer: the verdicts in animation_qa_results are keyed by clip_id
// and read by (a) the animation marketplace health surface (world-health /
// uptime), and (b) retarget-regression alerting, which queries
// `... WHERE passed = false` to catch a delivery/retarget break the same day it
// lands — mirroring how glb_canonicalization_results gates the avatar pipeline.

import { randomUUID } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { inspectGlb } from '../../glb-inspect.js';
import {
	payX402, bootstrapSolanaContext, USDC_MINT, FETCH_TIMEOUT_MS,
} from '../pay.js';

const log = logger('x402-animation-qa');

const ROUTE = '/api/x402/animation-download';
const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hard ceiling on the presigned GLB fetch — a single animation clip is tens to
// hundreds of KB; anything past this is treated as oversized rather than read
// into memory on a QA probe.
const MAX_GLB_BYTES = 96 * 1024 * 1024;

// Parse the canary clip set from env. Accepts "rig=uuid" pairs or bare uuids.
// Exported for the registry's enabled gate and for tests.
export function parseCanaryClips(
	raw = process.env.X402_ANIMATION_QA_CLIP_IDS || process.env.X402_ANIMATION_QA_CLIP_ID || '',
) {
	const seen = new Set();
	const out = [];
	for (const tok of String(raw).split(',')) {
		const t = tok.trim();
		if (!t) continue;
		const eq = t.indexOf('=');
		const rig = eq > 0 ? t.slice(0, eq).trim().toLowerCase() : null;
		const id = (eq > 0 ? t.slice(eq + 1) : t).trim();
		if (!UUID_RE.test(id) || seen.has(id)) continue;
		seen.add(id);
		out.push({ rig: rig || null, id });
	}
	return out;
}

export function hasCanaryClips() {
	return parseCanaryClips().length > 0;
}

let _schemaReady = false;
async function ensureSchema() {
	if (_schemaReady) return;
	// Per-clip QA verdict, latest state keyed by clip. History lives in
	// x402_autonomous_log; this table is the queryable current-state sink the
	// marketplace + alerting read.
	await sql`
		CREATE TABLE IF NOT EXISTS animation_qa_results (
			clip_id         uuid PRIMARY KEY,
			rig_type        text,
			clip_name       text,
			slug            text,
			declared_bytes  bigint,
			fetched_bytes   bigint,
			valid_glb       boolean NOT NULL DEFAULT false,
			is_rigged       boolean,
			animation_count int,
			passed          boolean NOT NULL DEFAULT false,
			http_status     int,
			amount_atomic   bigint,
			tx_signature    text,
			error_msg       text,
			run_id          uuid,
			checked_at      timestamptz DEFAULT now()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS animation_qa_results_passed_ts ON animation_qa_results (passed, checked_at DESC)`;
	// The autonomous log predates run()-style value extraction; add the column
	// the QA verdict is recorded into (idempotent — shared with other pipelines).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

// Per-call row into x402_autonomous_log (the loop records one aggregate summary
// row for the run() entry; these are the granular per-clip rows the QA owns).
async function recordCall(runId, { clip, endpointUrl, amountAtomic, txSig, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'},
				 ${`Animation QA: ${clip.rig || 'clip'} ${clip.id.slice(0, 8)}`}, ${endpointUrl},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${ASSET}, ${txSig || null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'qa'})
		`;
	} catch (err) {
		log.warn('animation_qa_log_insert_failed', { clip: clip.id, message: err?.message });
	}
}

async function upsertVerdict(runId, clip, v) {
	try {
		await sql`
			INSERT INTO animation_qa_results
				(clip_id, rig_type, clip_name, slug, declared_bytes, fetched_bytes,
				 valid_glb, is_rigged, animation_count, passed, http_status,
				 amount_atomic, tx_signature, error_msg, run_id, checked_at)
			VALUES
				(${clip.id}, ${clip.rig}, ${v.clip_name}, ${v.slug},
				 ${v.declared_bytes}, ${v.fetched_bytes}, ${v.valid_glb},
				 ${v.is_rigged}, ${v.animation_count}, ${v.passed}, ${v.http_status},
				 ${v.amount_atomic}, ${v.tx_signature}, ${v.error_msg}, ${runId}, now())
			ON CONFLICT (clip_id) DO UPDATE SET
				rig_type        = EXCLUDED.rig_type,
				clip_name       = EXCLUDED.clip_name,
				slug            = EXCLUDED.slug,
				declared_bytes  = EXCLUDED.declared_bytes,
				fetched_bytes   = EXCLUDED.fetched_bytes,
				valid_glb       = EXCLUDED.valid_glb,
				is_rigged       = EXCLUDED.is_rigged,
				animation_count = EXCLUDED.animation_count,
				passed          = EXCLUDED.passed,
				http_status     = EXCLUDED.http_status,
				amount_atomic   = EXCLUDED.amount_atomic,
				tx_signature    = EXCLUDED.tx_signature,
				error_msg       = EXCLUDED.error_msg,
				run_id          = EXCLUDED.run_id,
				checked_at      = now()
		`;
	} catch (err) {
		log.warn('animation_qa_upsert_failed', { clip: clip.id, message: err?.message });
	}
}

// Fetch the presigned GLB bytes (real network). Returns a Buffer or throws.
async function fetchGlbBytes(url) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
		if (!res.ok) throw new Error(`glb_fetch_http_${res.status}`);
		const len = Number(res.headers.get('content-length') || 0);
		if (len > MAX_GLB_BYTES) throw new Error(`glb_oversized:${len}`);
		const ab = await res.arrayBuffer();
		if (ab.byteLength > MAX_GLB_BYTES) throw new Error(`glb_oversized:${ab.byteLength}`);
		return Buffer.from(ab);
	} finally {
		clearTimeout(t);
	}
}

// Pay for + validate a single canary clip end-to-end. Never throws — every
// fault becomes a recorded verdict with passed:false.
async function gradeClip(runId, clip, ctx) {
	const { origin, buyer, conn, blockhash, mintInfo, remainingCap } = ctx;
	const endpointUrl = `${origin}${ROUTE}?id=${encodeURIComponent(clip.id)}`;
	const t0 = Date.now();

	const verdict = {
		clip_name: null, slug: null, declared_bytes: null, fetched_bytes: null,
		valid_glb: false, is_rigged: null, animation_count: null, passed: false,
		http_status: null, amount_atomic: 0, tx_signature: null, error_msg: null,
	};

	// Step 1 — probe + pay the paid-download endpoint.
	let pay;
	try {
		pay = await payX402({
			url: endpointUrl, method: 'GET',
			buyer, conn, blockhash, mintInfo, remainingCap,
		});
	} catch (err) {
		verdict.error_msg = err?.message || 'pay_failed';
		await finishClip(runId, clip, endpointUrl, verdict, t0, { paid: false, amountAtomic: 0 });
		return { verdict, amountAtomic: 0, paid: false, txSig: null, delivered: false };
	}

	verdict.http_status = pay.status ?? null;
	verdict.amount_atomic = pay.amountAtomic || 0;
	verdict.tx_signature = pay.txSig || null;

	const body = pay.responseBody;
	if (!pay.success || !body || typeof body !== 'object') {
		verdict.error_msg = pay.errorMsg || `delivery_failed_${pay.status || '0'}`;
		await finishClip(runId, clip, endpointUrl, verdict, t0, pay);
		return { verdict, amountAtomic: pay.amountAtomic || 0, paid: !!pay.paid, txSig: pay.txSig, delivered: false };
	}

	// Step 2 — the JSON unlock payload (id, name, sizeBytes, downloadUrl).
	verdict.clip_name = body.name || null;
	verdict.slug = body.slug || null;
	verdict.declared_bytes = body.sizeBytes != null ? Number(body.sizeBytes) : null;
	if (!body.downloadUrl) {
		verdict.error_msg = 'no_download_url';
		await finishClip(runId, clip, endpointUrl, verdict, t0, pay);
		return { verdict, amountAtomic: pay.amountAtomic || 0, paid: !!pay.paid, txSig: pay.txSig, delivered: false };
	}

	// Step 3 — fetch the actual GLB and inspect it. This is the regression guard:
	// the bytes must be a valid binary glTF whose animation track survived.
	let buf;
	try {
		buf = await fetchGlbBytes(body.downloadUrl);
	} catch (err) {
		verdict.error_msg = err?.message || 'glb_fetch_failed';
		await finishClip(runId, clip, endpointUrl, verdict, t0, pay);
		return { verdict, amountAtomic: pay.amountAtomic || 0, paid: !!pay.paid, txSig: pay.txSig, delivered: true };
	}

	verdict.fetched_bytes = buf.length;
	const glb = inspectGlb(buf);
	if (!glb || !glb.valid) {
		verdict.error_msg = 'invalid_glb';
		await finishClip(runId, clip, endpointUrl, verdict, t0, pay);
		return { verdict, amountAtomic: pay.amountAtomic || 0, paid: !!pay.paid, txSig: pay.txSig, delivered: true };
	}

	verdict.valid_glb = true;
	verdict.is_rigged = !!glb.isRigged;
	verdict.animation_count = Number(glb.animationCount || 0);
	// A delivered clip passes only when the bytes are a real, non-empty GLB that
	// still carries at least one animation channel — the retargeted/baked clip.
	verdict.passed = buf.length > 0 && verdict.animation_count >= 1;
	if (!verdict.passed) verdict.error_msg = 'no_animation_channels';

	await finishClip(runId, clip, endpointUrl, verdict, t0, pay);
	return { verdict, amountAtomic: pay.amountAtomic || 0, paid: !!pay.paid, txSig: pay.txSig, delivered: true };
}

// Persist a graded clip: the dedicated verdict row + the per-call log row.
async function finishClip(runId, clip, endpointUrl, verdict, t0, pay) {
	await upsertVerdict(runId, clip, verdict);
	await recordCall(runId, {
		clip,
		endpointUrl,
		amountAtomic: verdict.amount_atomic,
		txSig: verdict.tx_signature,
		durationMs: Date.now() - t0,
		success: !!(pay && pay.success) && verdict.passed,
		errorMsg: verdict.error_msg,
		valueExtracted: {
			rig: clip.rig, clip_id: clip.id, clip_name: verdict.clip_name,
			declared_bytes: verdict.declared_bytes, fetched_bytes: verdict.fetched_bytes,
			valid_glb: verdict.valid_glb, is_rigged: verdict.is_rigged,
			animation_count: verdict.animation_count, passed: verdict.passed,
		},
	});
}

/**
 * Run the Animation Retargeting QA sweep. Conforms to the run()-style registry
 * contract: the loop hands over { origin, buyer, conn, blockhash, mintInfo,
 * remainingCap, runId }; called standalone it bootstraps its own Solana context.
 *
 * Returns the aggregate outcome the loop records as one summary row:
 *   { success, amountAtomic, txSig, errorMsg, responseData, signalData, skipped, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	let remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;

	const clips = parseCanaryClips();
	if (clips.length === 0) {
		log.info('animation_qa_skipped', { reason: 'no_canary_clips' });
		return { success: false, skipped: true, amountAtomic: 0, note: 'no_canary_clips' };
	}

	// Schema first — without the sink there is no value to extract, so don't pay.
	try {
		await ensureSchema();
	} catch (err) {
		log.warn('animation_qa_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	// Solana payment context: reuse the loop's, else bootstrap (graceful on an
	// unconfigured wallet — bootstrap throws, we exit logged without paying).
	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			log.info('animation_qa_skipped', { reason: err.message });
			return { success: false, skipped: true, amountAtomic: 0, errorMsg: err.message, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	let spentAtomic = 0;
	let paid = 0;
	let passed = 0;
	let lastTxSig = null;
	const verdicts = [];

	for (const clip of clips) {
		if (remainingCap <= 0) {
			log.info('animation_qa_cap_reached', { spent_atomic: spentAtomic });
			break;
		}
		const r = await gradeClip(runId, clip, { origin, buyer, conn, blockhash, mintInfo, remainingCap });
		verdicts.push({ rig: clip.rig, clip_id: clip.id, passed: r.verdict.passed, animations: r.verdict.animation_count, error: r.verdict.error_msg });
		if (r.paid) {
			spentAtomic += r.amountAtomic;
			remainingCap -= r.amountAtomic;
			paid += 1;
			if (r.txSig) lastTxSig = r.txSig;
		}
		if (r.verdict.passed) passed += 1;
	}

	const failed = verdicts.length - passed;
	log.info('animation_qa_complete', {
		run_id: runId,
		clips: clips.length,
		checked: verdicts.length,
		paid,
		passed,
		failed,
		spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	const summary = { clips: clips.length, checked: verdicts.length, paid, passed, failed, verdicts };
	return {
		// success means the sweep ran and settled — kept independent of QA pass/fail
		// so the loop always accounts the USDC actually spent against the daily cap.
		// A retarget regression surfaces via errorMsg + the per-clip success=false
		// log rows + animation_qa_results.passed=false, not by zeroing this flag.
		success: verdicts.length > 0,
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		errorMsg: failed > 0 ? `animation_qa_failed:${failed}/${verdicts.length}` : null,
		responseData: summary,
		signalData: summary,
		skipped: verdicts.length === 0,
		note: `animation_qa passed=${passed}/${verdicts.length} paid=${paid}`,
	};
}

// api/_lib/x402/pipelines/model-metadata-enrichment.js
//
// Model Metadata Enrichment — autonomous pipeline (self/016).
//
// On each run it finds public avatars that have no tags yet and pays the x402
// `inspect_model` MCP tool ($0.01 USDC/call, advertised by /api/mcp) to parse
// each one's GLB. The structural report (mesh/skin/animation counts, triangle
// budget, compression extensions) is turned into searchable feature tags + a
// model category and written back to the avatars table — the input the search
// facets and the recommendation engine read from. The pipeline:
//
//   1. Selects a batch of untagged public avatars (selectUntaggedAvatars).
//   2. Pays inspect_model for each via the shared payX402 client (real on-chain
//      USDC from the seed wallet — never mocked).
//   3. Derives { tags, model_category } from the inspection and writes them to
//      avatars.tags / avatars.model_category (untagged-only, never clobbering).
//   4. Records a row in x402_autonomous_log for every call (success or failure),
//      with the derived metadata in value_extracted.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js. The per-tick
// loop (api/cron/x402-autonomous-loop.js) hands run() a shared payment context
// (buyer, conn, blockhash, mintInfo, remainingCap, runId, origin); called
// standalone (manual test) it bootstraps its own via bootstrapSolanaContext().
//
// Downstream consumer: api/_lib/avatars.js → listPublicAvatars({ tag, category })
// filters on `any(tags)` and `model_category`; until a row is enriched here it is
// invisible to those facets. The recommendation engine reads the same tags array.

import { randomUUID } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { payX402, bootstrapSolanaContext, USDC_MINT } from '../pay.js';
import {
	selectUntaggedAvatars,
	inspectModelRpcBody,
	enrichFromInspection,
} from '../enrich-model-metadata.js';

const log = logger('x402-model-enrich');

// Models inspected per run. Each is one $0.01 USDC payment, so a full batch is
// ≤ $0.10 — comfortably inside the loop's daily cap, and bounded again by the
// remainingCap the loop passes in.
const BATCH_SIZE = Number(process.env.X402_MODEL_ENRICH_BATCH || 10);

const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ENDPOINT_PATH = '/api/mcp';

let _schemaReady = false;
async function ensureSchema() {
	if (_schemaReady) return;
	// The autonomous log predates the value_extracted column on some envs; add it
	// idempotently so this pipeline can record its derived metadata there.
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

// One row per inspected avatar into x402_autonomous_log (the loop also records a
// single aggregate summary row for the run() entry; these are the granular ones).
async function recordCall(runId, { slug, endpointUrl, amountAtomic, txSig, responseData, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${`Model Enrichment: ${slug || 'unknown'}`}, ${endpointUrl},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${ASSET}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'3d'})
		`;
	} catch (err) {
		log.warn('model_enrich_log_insert_failed', { slug, message: err?.message });
	}
}

/**
 * Run the enrichment sweep. Conforms to the run()-style registry contract: the
 * loop hands over { origin, buyer, conn, blockhash, mintInfo, remainingCap,
 * runId }; standalone (manual test) it bootstraps its own Solana context.
 *
 * Returns the aggregate outcome the loop records as one summary row:
 *   { success, amountAtomic, txSig, errorMsg, responseData, skipped, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const endpointUrl = `${origin}${ENDPOINT_PATH}`;
	let remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;

	// ── Schema first: without the value sink, don't pay.
	try {
		await ensureSchema();
	} catch (err) {
		log.warn('model_enrich_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	// ── Find work before touching the wallet — nothing untagged → no spend.
	const targets = await selectUntaggedAvatars(BATCH_SIZE);
	if (targets.length === 0) {
		return { success: true, skipped: true, amountAtomic: 0, note: 'no_untagged_avatars' };
	}

	// ── Solana payment context: reuse the loop's, else bootstrap (graceful on an
	//    unconfigured wallet — bootstrap throws, we exit logged without paying).
	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			log.info('model_enrich_skipped', { reason: err.message });
			return { success: false, skipped: true, amountAtomic: 0, errorMsg: err.message, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	let spentAtomic = 0;
	let paid = 0;
	let enriched = 0;
	let lastTxSig = null;
	let callErrors = 0;

	for (let i = 0; i < targets.length; i++) {
		const target = targets[i];
		if (remainingCap <= 0) {
			log.info('model_enrich_cap_reached', { spent_atomic: spentAtomic, remaining_targets: targets.length - i });
			break;
		}

		const t0 = Date.now();
		let result;
		try {
			result = await payX402({
				url: endpointUrl,
				method: 'POST',
				body: inspectModelRpcBody(target.glb_url),
				buyer, conn, blockhash, mintInfo,
				remainingCap,
			});
		} catch (err) {
			// Network failure / abort — log the call, never crash the sweep.
			callErrors += 1;
			await recordCall(runId, {
				slug: target.slug, endpointUrl, amountAtomic: 0, txSig: null, responseData: null,
				durationMs: Date.now() - t0, success: false, errorMsg: err?.message || 'fetch_failed', valueExtracted: null,
			});
			continue;
		}

		if (result.paid) {
			spentAtomic += result.amountAtomic;
			remainingCap -= result.amountAtomic;
			paid += 1;
			if (result.txSig) lastTxSig = result.txSig;
		}

		// Derive + persist the metadata only when the call delivered a result.
		let valueExtracted = null;
		if (result.success) {
			try {
				valueExtracted = await enrichFromInspection({
					responseBody: result.responseBody,
					avatarId: target.id,
					slug: target.slug,
				});
				if (valueExtracted?.applied) enriched += 1;
			} catch (err) {
				// DB write failed — the payment already settled, so record the call as
				// a success but surface the persistence error for observability.
				log.warn('model_enrich_persist_failed', { slug: target.slug, message: err?.message });
			}
		} else {
			callErrors += 1;
		}

		await recordCall(runId, {
			slug: target.slug,
			endpointUrl,
			amountAtomic: result.amountAtomic,
			txSig: result.txSig,
			// Keep the row compact — the derived tags live in value_extracted; drop
			// the bulky inspection payload, retaining only call status + rpc error.
			responseData: { status: result.status, rpc_error: result.responseBody?.error || null },
			durationMs: Date.now() - t0,
			success: result.success,
			errorMsg: result.errorMsg,
			valueExtracted,
		});
	}

	log.info('model_enrich_complete', {
		run_id: runId,
		targets: targets.length,
		paid,
		enriched,
		spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	return {
		success: paid > 0 || enriched > 0,
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		errorMsg: paid === 0 && callErrors > 0 ? `model_enrich_calls_failed:${callErrors}` : null,
		skipped: paid === 0 && enriched === 0,
		responseData: { targets: targets.length, paid, enriched },
		note: `model_enrich targets=${targets.length} paid=${paid} enriched=${enriched}`,
	};
}

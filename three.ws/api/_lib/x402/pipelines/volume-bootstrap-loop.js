// api/_lib/x402/pipelines/volume-bootstrap-loop.js
//
// x402 Volume Bootstrap Loop — autonomous pipeline (self/026).
//
// The core volume engine. Round-robins through the full catalog of paid, cheap
// three.ws self x402 endpoints, paying each one a real on-chain USDC payment from
// the seed wallet. It is NOT a single endpoint call — it is the sweep that proves
// every paid endpoint is live and continuously settles small ($0.001-$0.01)
// payments across all of them so the platform accrues genuine agent-to-agent
// transaction volume (the metric agentic.market ranks facilitators on).
//
// Fires every 5 minutes from the autonomous loop. The per-minute cadence for
// steady, capped ring traffic lives in api/cron/x402-ring-tick.js — both drivers
// share one payment + recording path (pipelines/volume-shared.js), so there is
// exactly one settlement code path, not two that drift.
//
// On each run it:
//   1. Advances a Redis-backed round-robin cursor and reserves the next window of
//      VOLUME_BATCH_PER_RUN endpoints from VOLUME_ENDPOINTS (stable across warm
//      instances; in-memory fallback when Redis is absent).
//   2. Pays each selected endpoint via the shared payX402 client — real 402
//      probe → signed Solana USDC transfer → replay with X-PAYMENT. Never mocked.
//   3. Respects two budgets: the loop's remaining daily cap AND a self-imposed
//      per-run cap (VOLUME_PER_RUN_CAP_ATOMIC) so one tick can't drain the day.
//   4. Records a row in x402_autonomous_log for EVERY call (success or failure),
//      with the per-endpoint cumulative volume snapshot in value_extracted.
//   5. Upserts the per-endpoint volume ledger into x402_volume_metrics — call /
//      success / fail counts, total + last USDC spent, last tx signature, last
//      status, last error, first/last call timestamps.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js
// (`volume-bootstrap-loop`). The per-tick spend loop (api/cron/x402-autonomous-loop.js)
// hands run() a shared payment context (buyer, conn, blockhash, mintInfo,
// remainingCap); called standalone (manual test) it bootstraps its own via
// bootstrapSolanaContext(), degrading gracefully if the wallet is unconfigured.
//
// Downstream consumer: x402_volume_metrics is the per-endpoint volume ledger the
// platform's growth + status surfaces read — total settled calls and USDC volume
// per endpoint (the proof-of-volume that bootstraps agentic.market ranking) and
// the per-endpoint last_success / last_called_at that confirms each paid endpoint
// is live. It complements x402_autonomous_log (per-call history) with a compact
// rolling aggregate keyed on endpoint.

import { randomUUID } from 'node:crypto';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { payX402, bootstrapSolanaContext } from '../pay.js';
import {
	ASSET,
	VOLUME_ENDPOINTS,
	VOLUME_BATCH_PER_RUN,
	VOLUME_PER_RUN_CAP_ATOMIC,
	reserveWindow,
	ensureVolumeSchema,
	settleAndRecord,
} from './volume-shared.js';

const log = logger('x402-volume-bootstrap');

// Re-exported for the registry, the ring tick, and existing tests that read the
// catalog and caps from this module. The canonical definitions live in
// volume-shared.js so both drivers agree.
export { ASSET, VOLUME_ENDPOINTS, VOLUME_BATCH_PER_RUN, VOLUME_PER_RUN_CAP_ATOMIC };

const CURSOR_KEY = 'x402:auto:volume:cursor';

/**
 * Run the volume bootstrap sweep. Conforms to the run()-style registry contract:
 * the loop hands over { origin, buyer, conn, blockhash, mintInfo, remainingCap,
 * runId, sql }; standalone callers (manual test) get a bootstrapped context.
 *
 * Returns the aggregate outcome the loop records as one summary row:
 *   { success, amountAtomic, txSig, errorMsg, responseData, skipped, note }
 */
export async function run(ctx = {}) {
	const sql = ctx.sql || defaultSql;
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const redis = ctx.redis || null;

	// ── Schema first: without the sink there is nothing to extract value into, so
	//    don't pay. A schema failure is a graceful skip (no spend).
	try {
		await ensureVolumeSchema(sql);
	} catch (err) {
		log.warn('volume_bootstrap_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	// ── Solana payment context: reuse the loop's, else bootstrap. A bootstrap
	//    failure (wallet/RPC unconfigured) exits logged, without paying.
	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			log.info('volume_bootstrap_skipped', { reason: err.message });
			return { success: false, skipped: true, amountAtomic: 0, errorMsg: err.message, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	// ── Budget: the smaller of the loop's remaining daily cap and our per-run cap.
	const loopCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;
	let remaining = VOLUME_PER_RUN_CAP_ATOMIC > 0
		? Math.min(loopCap, VOLUME_PER_RUN_CAP_ATOMIC)
		: loopCap;

	// ── Select this run's window of endpoints (round-robin).
	const indices = await reserveWindow(redis, VOLUME_BATCH_PER_RUN, VOLUME_ENDPOINTS.length, CURSOR_KEY);

	let spentAtomic = 0;
	let paid = 0;
	let calls = 0;
	let errors = 0;
	let lastTxSig = null;
	const swept = [];

	for (const idx of indices) {
		const ep = VOLUME_ENDPOINTS[idx];
		if (remaining <= 0) {
			log.info('volume_bootstrap_cap_reached', { endpoint: ep.key, spent_atomic: spentAtomic });
			break;
		}

		const { result, paidAmount } = await settleAndRecord({
			sql, runId, ep, origin, remaining,
			ctx: { buyer, conn, blockhash, mintInfo },
			pipeline: 'volume', namePrefix: 'Volume', payFn: payX402, log,
		});

		calls += 1;
		if (!result.success) errors += 1;
		if (result.paid) {
			spentAtomic += paidAmount;
			remaining -= paidAmount;
			paid += 1;
			if (result.txSig) lastTxSig = result.txSig;
		}

		swept.push({ key: ep.key, paid: result.paid === true, success: result.success, status: result.status });
	}

	log.info('volume_bootstrap_complete', {
		run_id: runId,
		window: indices.length,
		calls,
		paid,
		errors,
		spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	// Aggregate outcome for the loop's single summary row. success=true when at
	// least one endpoint settled or answered; per-call detail lives in the rows
	// above. skipped only when the window produced no calls at all.
	return {
		success: paid > 0 || (calls > 0 && errors < calls),
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		errorMsg: paid === 0 && errors > 0 ? `volume_bootstrap_calls_failed:${errors}/${calls}` : null,
		skipped: calls === 0,
		responseData: { window: indices.length, calls, paid, errors, swept },
		signalData: { calls, paid, errors, spent_atomic: spentAtomic },
		note: `volume_bootstrap calls=${calls} paid=${paid} errors=${errors}`,
	};
}

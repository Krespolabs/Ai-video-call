// api/_lib/x402/pipelines/spend-reservation-leak-detector.js
//
// Spend Reservation Leak Detector — the work behind the
// `spend-reservation-leak-detector` autonomous-registry entry (self/Finance).
//
// THE LEAK IT HUNTS
// -----------------
// Every autonomous outbound spend is two-phase: first a reservation row is
// written that immediately claims headroom against the agent's rolling-24h cap,
// then — after the on-chain send settles or fails — the reservation is FINALIZED
// (advanced to confirmed) or RELEASED (so it stops counting). The release path is
// `releaseSpendReservation()` (USD cap, agent_trade-guards.js → agent_custody_events)
// and `releaseSpend()` (SOL cap, agent-spend-policy.js → agent_actions).
//
// If the process dies between reserve and finalize/release — a crash, a timeout, a
// thrown error on a path that forgot its `finally` — the reservation is ORPHANED.
// It still holds cap headroom it will never spend. Enough orphans and the agent's
// daily cap is silently exhausted by money that never moved: every real spend then
// fails `daily_exceeded` even though the wallet is full. That is the leak.
//
// A reservation older than one hour that is still `pending` (USD) or still
// `reserved` (SOL) is unambiguously orphaned: Solana settles in seconds, so a
// healthy reserve is finalized or released within that window many times over. One
// hour is ~100× the settlement time — nothing legitimate is still in flight.
//
// WHAT THIS PIPELINE DOES (every 15 min)
// --------------------------------------
//   1. Scans agent_custody_events for event_type='spend', status='pending',
//      created_at < now()-1h  → leaked USD reservations.
//   2. Scans agent_actions for the SOL-outflow types still payload.status='reserved'
//      and created_at < now()-1h  → leaked SOL reservations.
//   3. Cleans each up through the REAL release path so the freed headroom is
//      identical to what a correct finalize/release would have produced:
//        • USD  → releaseSpendReservation(id, 'leak_detector_swept') — marks the
//                 pending row 'failed' (audit row preserved, stops counting).
//        • SOL  → record the leak first (releaseSpend DELETEs, so we capture the
//                 evidence into the value sink), then releaseSpend(id).
//   4. Records every swept leak into `spend_reservation_leaks` (the value sink) and
//      publishes a compact alert/latest state to Redis for cheap consumer reads.
//   5. Records ONE x402_autonomous_log row with value_extracted = the sweep summary.
//
// COST: free. The endpoint is a pure DB maintenance query — no x402 challenge, no
// outbound payment, amountAtomic always 0. Like the revenue-reconciliation pipeline
// it is read/write-against-our-own-DB only, so it runs WITHOUT the spend wallet:
// a leaked-reservation sweep must never be blocked by a missing keypair, since an
// unconfigured wallet is exactly when nothing else can free the cap.
//
// VALUE SINK: spend_reservation_leaks (one row per swept leak, keyed UNIQUE on
// (source, source_ref)) + Redis x402:reservation-leak:{latest,alert}.
// DOWNSTREAM CONSUMER: api/ops/health.js loadReservationLeaks() folds a spike in
// freshly-swept leaks into the platform health verdict (a sustained leak rate means
// a reserve→finalize path is crashing and quietly starving agent spend caps); the
// Redis alert key gives the status dashboard a one-GET read of the current state.

import { randomUUID } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { releaseSpendReservation } from '../../agent-trade-guards.js';
import { releaseSpend, SOL_OUTFLOW_TYPES } from '../../agent-spend-policy.js';
import { USDC_MINT } from '../pay.js';

const log = logger('x402-reservation-leak-detector');

const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// A reservation older than this with no finalize/release is orphaned. Solana
// settles in seconds; 1h is ~100× the settlement window, so nothing legitimate is
// still in flight. Env-tunable for environments with slower settlement rails.
const LEAK_AGE_SECONDS = Math.max(
	300,
	Number(process.env.X402_RESERVATION_LEAK_AGE_SECONDS || 3600),
);

// Hard bound on rows touched per run so one tick can never be unbounded if a bug
// floods the tables with leaks. The 15-min cadence drains any backlog across runs.
const MAX_SWEEP_PER_SOURCE = Math.max(
	1,
	Number(process.env.X402_RESERVATION_LEAK_MAX_PER_RUN || 500),
);

const REDIS_LATEST_KEY = 'x402:reservation-leak:latest';
const REDIS_ALERT_KEY = 'x402:reservation-leak:alert';
// Alert/latest TTL: a little over two 15-min cycles so a missed run lets the flag
// lapse to "unknown" rather than latching a stale alert forever.
const REDIS_TTL_SECONDS = 40 * 60;

async function ensureSchema(db) {
	await db`
		CREATE TABLE IF NOT EXISTS spend_reservation_leaks (
			id           bigserial   PRIMARY KEY,
			source       text        NOT NULL,        -- 'custody_event' | 'agent_action'
			source_ref   text        NOT NULL,        -- row id in the originating table
			agent_id     text,
			asset        text,                          -- 'USDC' | 'SOL' | mint
			usd          float8,                        -- freed USD cap headroom (custody)
			sol_amount   float8,                        -- freed SOL cap headroom (action)
			category     text,                          -- spend category / action type
			age_seconds  int,                           -- reservation age at sweep
			action       text        NOT NULL,         -- 'released' | 'deleted'
			run_id       uuid,
			reserved_at  timestamptz,
			swept_at     timestamptz NOT NULL DEFAULT now(),
			UNIQUE (source, source_ref)
		)
	`;
	await db`CREATE INDEX IF NOT EXISTS spend_reservation_leaks_swept_idx
		ON spend_reservation_leaks (swept_at DESC)`;
	// The autonomous log predates this pipeline; ensure the column its summary lands
	// in exists (idempotent — shared with every other run() that writes it).
	await db`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
}

// Persist a swept leak into the value sink. Idempotent on (source, source_ref) so a
// re-record within a run (or an overlapping run) can never double-insert.
async function recordLeak(db, runId, leak) {
	await db`
		INSERT INTO spend_reservation_leaks
			(source, source_ref, agent_id, asset, usd, sol_amount, category,
			 age_seconds, action, run_id, reserved_at, swept_at)
		VALUES
			(${leak.source}, ${leak.source_ref}, ${leak.agent_id ?? null},
			 ${leak.asset ?? null}, ${leak.usd ?? null}, ${leak.sol_amount ?? null},
			 ${leak.category ?? null}, ${leak.age_seconds ?? null}, ${leak.action},
			 ${runId}, ${leak.reserved_at ?? null}, now())
		ON CONFLICT (source, source_ref) DO UPDATE SET
			action      = EXCLUDED.action,
			usd         = EXCLUDED.usd,
			sol_amount  = EXCLUDED.sol_amount,
			age_seconds = EXCLUDED.age_seconds,
			run_id      = EXCLUDED.run_id,
			swept_at    = now()
	`;
}

// ── USD reservations (agent_custody_events) ─────────────────────────────────────
// Leaked = event_type 'spend', status 'pending', older than the leak window. The
// release path marks the pending row 'failed' (preserving the audit row) so it
// stops counting toward getDailySpendUsd — exactly what a correct releaseSpendReservation
// at the spend site would have done.
async function sweepCustodyLeaks(db, runId, releaseUsd) {
	let rows = [];
	try {
		rows = await db`
			SELECT id, agent_id, asset, usd, category,
			       extract(epoch FROM (now() - created_at))::int AS age_seconds,
			       created_at
			FROM agent_custody_events
			WHERE event_type = 'spend'
			  AND status = 'pending'
			  AND created_at < now() - (${LEAK_AGE_SECONDS} || ' seconds')::interval
			ORDER BY created_at ASC
			LIMIT ${MAX_SWEEP_PER_SOURCE}
		`;
	} catch (err) {
		if (!/does not exist/.test(err?.message || '')) {
			log.warn('custody_scan_failed', { message: err?.message });
		}
		return { scanned: 0, swept: [], usdFreed: 0 };
	}

	const swept = [];
	let usdFreed = 0;
	for (const r of rows) {
		try {
			// Free the cap through the real release path, then capture the evidence.
			await releaseUsd(r.id, 'leak_detector_swept');
			const usd = r.usd != null ? Number(r.usd) : null;
			if (usd) usdFreed += usd;
			const leak = {
				source: 'custody_event',
				source_ref: String(r.id),
				agent_id: r.agent_id ? String(r.agent_id) : null,
				asset: r.asset || 'USDC',
				usd,
				sol_amount: null,
				category: r.category || null,
				age_seconds: r.age_seconds ?? null,
				action: 'released',
				reserved_at: r.created_at || null,
			};
			await recordLeak(db, runId, leak);
			swept.push(leak);
		} catch (err) {
			log.warn('custody_sweep_failed', { id: String(r.id), message: err?.message });
		}
	}
	return { scanned: rows.length, swept, usdFreed };
}

// ── SOL reservations (agent_actions) ────────────────────────────────────────────
// Leaked = a SOL-outflow action still at payload.status 'reserved' past the window.
// releaseSpend() DELETEs the row (that is how the SOL cap is freed — the 24h cap
// query counts every outflow row regardless of status, so only removal frees it), so
// we record the leak into the value sink FIRST to preserve the evidence the delete
// would otherwise destroy.
async function sweepSolActionLeaks(db, runId, releaseSol) {
	let rows = [];
	try {
		rows = await db`
			SELECT id, agent_id, type,
			       (payload->>'solAmount')::float8 AS sol_amount,
			       payload->>'mint' AS mint,
			       extract(epoch FROM (now() - created_at))::int AS age_seconds,
			       created_at
			FROM agent_actions
			WHERE type = ANY(${SOL_OUTFLOW_TYPES})
			  AND payload->>'status' = 'reserved'
			  AND created_at < now() - (${LEAK_AGE_SECONDS} || ' seconds')::interval
			ORDER BY created_at ASC
			LIMIT ${MAX_SWEEP_PER_SOURCE}
		`;
	} catch (err) {
		if (!/does not exist/.test(err?.message || '')) {
			log.warn('sol_scan_failed', { message: err?.message });
		}
		return { scanned: 0, swept: [], solFreed: 0 };
	}

	const swept = [];
	let solFreed = 0;
	for (const r of rows) {
		try {
			const sol = r.sol_amount != null ? Number(r.sol_amount) : null;
			const leak = {
				source: 'agent_action',
				source_ref: String(r.id),
				agent_id: r.agent_id ? String(r.agent_id) : null,
				asset: 'SOL',
				usd: null,
				sol_amount: sol,
				category: r.type || null,
				age_seconds: r.age_seconds ?? null,
				action: 'deleted',
				reserved_at: r.created_at || null,
			};
			// Evidence first (releaseSpend destroys the source row), then free the cap.
			await recordLeak(db, runId, leak);
			await releaseSol(r.id);
			if (sol) solFreed += sol;
			swept.push(leak);
		} catch (err) {
			log.warn('sol_sweep_failed', { id: String(r.id), message: err?.message });
		}
	}
	return { scanned: rows.length, swept, solFreed };
}

// Publish the latest sweep + an alert flag (present only while leaks were found) to
// Redis for a cheap, DB-free consumer read. Mirrors the wallet-balance monitor's
// x402:wallet-balance:{latest,alert} convention so the status dashboard reads both
// the same way. Best-effort: a Redis hiccup never fails the sweep.
async function writeRedisState(redis, summary) {
	if (!redis) return;
	try {
		await redis.set(REDIS_LATEST_KEY, JSON.stringify(summary), { ex: REDIS_TTL_SECONDS });
		if (summary.leaked_total > 0) {
			await redis.set(REDIS_ALERT_KEY, JSON.stringify({
				leaked_total: summary.leaked_total,
				usd_freed: summary.usd_freed,
				sol_freed: summary.sol_freed,
				agents_affected: summary.agents_affected,
				oldest_age_seconds: summary.oldest_age_seconds,
				at: summary.at,
			}), { ex: REDIS_TTL_SECONDS });
		} else {
			// Clean run — drop any lingering alert so it doesn't latch stale.
			await redis.del(REDIS_ALERT_KEY);
		}
	} catch (err) {
		log.warn('leak_redis_write_failed', { message: err?.message });
	}
}

// Record this run's single summary row into x402_autonomous_log, with the sweep
// summary in value_extracted. Returns true on success.
async function recordLogRow(db, runId, { durationMs, success, errorMsg, summary }) {
	try {
		await db`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${'Spend Reservation Leak Detector'},
				 ${'/api/_lib/agent-trade-guards'},
				 ${'solana:mainnet'}, ${0}, ${ASSET}, ${null},
				 ${summary ? JSON.stringify(summary) : null},
				 ${summary ? JSON.stringify(summary) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'finance'})
		`;
		return true;
	} catch (err) {
		log.warn('leak_log_insert_failed', { message: err?.message });
		return false;
	}
}

/**
 * Run the leak sweep. Conforms to the run()-style registry contract: the loop hands
 * { origin, redis, sql, log, runId, ... }. Pure DB maintenance — no payment, no
 * wallet required (it runs even when the spend wallet is absent, exactly when the
 * cap most needs freeing). Records its own canonical log row, so it returns
 * `recorded: true` and the loop adds no duplicate summary row.
 *
 * Returns the aggregate outcome the loop surfaces:
 *   { success, amountAtomic, txSig, errorMsg, responseData, recorded, valueExtracted, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const redis = ctx.redis || null;
	// The loop hands its own sql in ctx; fall back to the module client for a
	// standalone/manual run. All of THIS pipeline's queries go through `db`.
	const db = ctx.sql || sql;
	// The canonical release paths (single source of truth for "free this reservation").
	// Overridable via ctx for the manual test; the loop never passes them, so
	// production always runs the real releasers.
	const releaseUsd = ctx.releaseSpendReservation || releaseSpendReservation;
	const releaseSol = ctx.releaseSpend || releaseSpend;
	const t0 = Date.now();

	// Schema first: without the value sink there is nowhere to record the evidence,
	// and recording before release is what keeps the SOL delete auditable.
	try {
		await ensureSchema(db);
	} catch (err) {
		log.warn('leak_schema_failed', { message: err?.message });
		const durationMs = Date.now() - t0;
		await recordLogRow(db, runId, {
			durationMs, success: false, errorMsg: `schema_failed: ${err?.message}`, summary: null,
		});
		return {
			success: false, amountAtomic: 0, txSig: null, recorded: true,
			errorMsg: `schema_failed: ${err?.message}`, note: 'leak sweep aborted: schema',
		};
	}

	// Each source sweep is independently guarded — a failure in one (e.g. a table
	// that doesn't exist in this env) degrades to "scanned 0" and never blocks the
	// other, and never crashes the tick.
	const custody = await sweepCustodyLeaks(db, runId, releaseUsd);
	const solActions = await sweepSolActionLeaks(db, runId, releaseSol);

	const allSwept = [...custody.swept, ...solActions.swept];
	const agents = new Set(allSwept.map((l) => l.agent_id).filter(Boolean));
	const oldestAge = allSwept.reduce((m, l) => Math.max(m, l.age_seconds || 0), 0);

	const summary = {
		at: new Date(t0).toISOString(),
		leak_age_seconds: LEAK_AGE_SECONDS,
		scanned: {
			custody_pending: custody.scanned,
			sol_reserved: solActions.scanned,
		},
		leaked: {
			custody_events: custody.swept.length,
			agent_actions: solActions.swept.length,
		},
		leaked_total: allSwept.length,
		usd_freed: Number(custody.usdFreed.toFixed(6)),
		sol_freed: Number(solActions.solFreed.toFixed(9)),
		agents_affected: agents.size,
		oldest_age_seconds: oldestAge,
		// Bounded sample for the log row; the full set lives in spend_reservation_leaks.
		sample: allSwept.slice(0, 20).map((l) => ({
			source: l.source, ref: l.source_ref, agent_id: l.agent_id,
			asset: l.asset, usd: l.usd, sol: l.sol_amount,
			age_seconds: l.age_seconds, action: l.action,
		})),
	};

	await writeRedisState(redis, summary);

	const durationMs = Date.now() - t0;
	// A clean run (nothing leaked) is a success — it proves the reserve→finalize
	// paths are healthy. Only an outright failure to scan/record is an error.
	await recordLogRow(db, runId, { durationMs, success: true, errorMsg: null, summary });

	if (summary.leaked_total > 0) {
		log.warn('reservation_leaks_swept', {
			run_id: runId,
			leaked_total: summary.leaked_total,
			custody: summary.leaked.custody_events,
			sol: summary.leaked.agent_actions,
			usd_freed: summary.usd_freed,
			sol_freed: summary.sol_freed,
			agents_affected: summary.agents_affected,
			oldest_age_seconds: summary.oldest_age_seconds,
			duration_ms: durationMs,
		});
	} else {
		log.info('reservation_leak_sweep_clean', {
			run_id: runId,
			scanned_custody: summary.scanned.custody_pending,
			scanned_sol: summary.scanned.sol_reserved,
			duration_ms: durationMs,
		});
	}

	return {
		success: true,
		amountAtomic: 0,
		txSig: null,
		errorMsg: null,
		recorded: true, // we wrote our own canonical row above
		valueExtracted: summary,
		responseData: {
			leaked_total: summary.leaked_total,
			usd_freed: summary.usd_freed,
			sol_freed: summary.sol_freed,
			agents_affected: summary.agents_affected,
		},
		note: summary.leaked_total > 0
			? `swept ${summary.leaked_total} leak(s): $${summary.usd_freed} + ${summary.sol_freed} SOL freed`
			: 'no leaked reservations',
	};
}

export const RESERVATION_LEAK_REDIS_LATEST_KEY = REDIS_LATEST_KEY;
export const RESERVATION_LEAK_REDIS_ALERT_KEY = REDIS_ALERT_KEY;
export const RESERVATION_LEAK_AGE_SECONDS = LEAK_AGE_SECONDS;

// api/_lib/x402/pump-launch-monitor.js
//
// Shared logic for the Pump Launch Monitor (Recent Launches) x402 use case.
//
// The autonomous loop pays /api/x402/pump-agent-audit in LIST mode
// (?limit=N&sort=newest) for the freshest pump.fun launches, then derives a
// compact sniper-screening signal from the response. This module owns:
//
//   1. classifyLaunchMonitor() — the extractSignal projection
//      { count, newest_mint, newest_name, newest_symbol, avg_initial_liquidity }
//      shared by the registry entry (→ x402_autonomous_log.signal_data) and the
//      snapshot writer so both always agree on shape.
//   2. ensurePumpLaunchSnapshotSchema() / storePumpLaunchSnapshot() — the value
//      sink: every paid snapshot is appended to pump_launch_snapshots (a time
//      series the sniper-screening surface and liquidity-baseline reads consume).
//
// Why this is actionable: a fresh launch whose initial bonding-curve liquidity
// sits well above the rolling average of its cohort is a high-conviction snipe
// candidate; one far below is noise. avg_initial_liquidity is that per-cohort
// baseline, captured at paid-call time so the screening read never re-hits the
// live pump.fun feed.

function num(v) {
	const n = typeof v === 'string' ? parseFloat(v) : v;
	return Number.isFinite(n) ? n : null;
}

// SOL liquidity above this average → bullish cohort signal (enough capital to
// move price; below this floor the cohort is noise-level activity).
const HIGH_LIQ_SOL = 20;

/**
 * Project a /api/x402/pump-agent-audit LIST response into the oracle signal.
 * Includes all sniper-screening fields plus the oracle envelope
 * (topic / signal / headline / confidence) so the autonomous loop can upsert
 * the result into oracle_intel_signals as well as x402_autonomous_log.signal_data.
 *
 * Tolerant of partial/empty payloads (feed outage → count 0, null fields) so it
 * never throws inside the loop's extractSignal call.
 *
 * @param {object|null} r raw list-mode JSON response
 * @returns {{
 *   topic: string, signal: string, headline: string, confidence: number,
 *   count: number, newest_mint: string|null, newest_name: string|null,
 *   newest_symbol: string|null, avg_initial_liquidity: number|null,
 *   max_initial_liquidity: number|null, agent_token_count: number
 * }}
 */
export function classifyLaunchMonitor(r) {
	const o = r || {};
	const launches = Array.isArray(o.launches) ? o.launches : [];
	const liq = launches.map((l) => num(l?.liquidity_sol)).filter((v) => v != null && v > 0);
	const avg = liq.length ? liq.reduce((a, b) => a + b, 0) / liq.length : null;
	const max = liq.length ? Math.max(...liq) : null;
	const agentTokens = launches.reduce((acc, l) => acc + (l?.is_agent_token ? 1 : 0), 0);

	const count = Number.isFinite(o.count) ? o.count : launches.length;
	const avgLiq = num(o.avg_initial_liquidity_sol) ?? avg;
	const maxLiq = num(o.max_initial_liquidity_sol) ?? max;
	const newestMint = o.newest_mint || launches[0]?.mint || null;
	const newestName = o.newest_name || launches[0]?.name || null;
	const newestSymbol = o.newest_symbol || launches[0]?.symbol || null;

	// Oracle signal: a cohort with high average liquidity is a bullish environment
	// for new launches — more capital on the bonding curve means more room for price
	// movement and a wider snipe window. A thin or empty cohort is neutral.
	const signal = count > 0 && avgLiq != null && avgLiq >= HIGH_LIQ_SOL ? 'bullish' : 'neutral';
	const solFmt = (v) => v != null ? `${Math.round(v * 10) / 10} SOL` : 'n/a';
	const headline = count > 0
		? `${count} new pump.fun launch${count !== 1 ? 'es' : ''} — avg ${solFmt(avgLiq)} liquidity, peak ${solFmt(maxLiq)}`
		: 'No recent pump.fun launches detected';
	// Confidence scales with cohort size: a single launch is uncertain (0.5),
	// 10+ launches give a reliable baseline (0.9 cap).
	const confidence = count > 0 ? Math.min(0.9, 0.5 + count * 0.04) : 0.3;

	return {
		topic: 'pump_launch_monitor',
		signal,
		headline,
		confidence,
		count,
		newest_mint: newestMint,
		newest_name: newestName,
		newest_symbol: newestSymbol,
		avg_initial_liquidity: avgLiq,
		max_initial_liquidity: maxLiq,
		agent_token_count: agentTokens,
	};
}

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _schemaReady = false;

/**
 * Create the snapshot time-series table if absent. Idempotent; the in-process
 * guard avoids re-issuing the DDL after the first successful call.
 * @param {Function} sql tagged-template sql client (api/_lib/db.js)
 */
export async function ensurePumpLaunchSnapshotSchema(sql) {
	if (_schemaReady || !sql) return;
	await sql`
		CREATE TABLE IF NOT EXISTS pump_launch_snapshots (
			id                         bigserial PRIMARY KEY,
			ts                         timestamptz NOT NULL DEFAULT now(),
			network                    text,
			sort                       text,
			launch_count               int,
			agent_token_count          int,
			newest_mint                text,
			newest_name                text,
			newest_symbol              text,
			avg_initial_liquidity_sol  double precision,
			max_initial_liquidity_sol  double precision,
			launches                   jsonb,
			run_id                     uuid,
			source                     text NOT NULL DEFAULT 'x402-autonomous'
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS pump_launch_snapshots_ts_desc
			ON pump_launch_snapshots (ts DESC)
	`;
	_schemaReady = true;
}

/**
 * Append one recent-launch snapshot to the time series. Wired as the registry
 * entry's storeValue hook; the loop wraps it so a DB fault can never crash the
 * tick. Skips writing an empty snapshot (feed outage) so the baseline series
 * only ever holds real cohorts.
 *
 * @param {object} ctx { sql, responseBody, signalData, runId }
 */
export async function storePumpLaunchSnapshot({ sql, responseBody, signalData, runId }) {
	if (!sql) return;
	const r = responseBody || {};
	const v = signalData || classifyLaunchMonitor(r);
	if (!v.count) return; // never persist an empty/failed snapshot
	await ensurePumpLaunchSnapshotSchema(sql);
	const launches = Array.isArray(r.launches) ? r.launches : [];
	await sql`
		INSERT INTO pump_launch_snapshots
			(ts, network, sort, launch_count, agent_token_count,
			 newest_mint, newest_name, newest_symbol,
			 avg_initial_liquidity_sol, max_initial_liquidity_sol,
			 launches, run_id, source)
		VALUES
			(now(), ${r.network || 'mainnet'}, ${r.sort || 'newest'},
			 ${v.count}, ${v.agent_token_count || 0},
			 ${v.newest_mint}, ${v.newest_name}, ${v.newest_symbol},
			 ${v.avg_initial_liquidity}, ${v.max_initial_liquidity},
			 ${JSON.stringify(launches)}, ${runId || null}, ${'x402-autonomous'})
	`;
}

/**
 * Latest stored launch snapshot, or null when the series is empty. Reader for the
 * sniper-screening surface and liquidity-baseline lookups.
 * @param {Function} sql
 */
export async function getLatestLaunchSnapshot(sql) {
	if (!sql) return null;
	const rows = await sql`
		SELECT ts, network, sort, launch_count, agent_token_count,
		       newest_mint, newest_name, newest_symbol,
		       avg_initial_liquidity_sol, max_initial_liquidity_sol, launches
		FROM pump_launch_snapshots
		ORDER BY ts DESC
		LIMIT 1
	`;
	return rows[0] || null;
}

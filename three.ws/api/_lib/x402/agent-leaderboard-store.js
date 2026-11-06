// api/_lib/x402/agent-leaderboard-store.js
//
// Value store for the Agent x402 Spend Leaderboard (USE-043).
//
// The x402 autonomous loop pays /api/x402/analytics (report=agent_leaderboard)
// on a schedule (registry entry `agent-spend-leaderboard`) and snapshots the
// top agents by x402 spend this week. This module owns the snapshot table so the
// writer (registry storeValue) and any reader agree on shape, mirroring the
// three-signal-store.js idiom.
//
// Consumer: partnership-outreach tooling reads the latest snapshot to find the
// highest-value paying agents (top_agent_id + the full ranking) to prioritize
// for outreach — the actionable signal this pipeline extracts.

function num(v) {
	const n = typeof v === 'string' ? parseFloat(v) : v;
	return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a /api/x402/analytics (agent_leaderboard) response into the signal
 * shape stored in x402_autonomous_log.signal_data AND used to drive the snapshot
 * insert. Shared by the registry's extractSignal and storeValue so both agree.
 *
 * @param {object|null} r raw analytics response
 * @returns {{
 *   topic: string, report: string, window_days: number|null,
 *   agent_count: number, total_spend_usdc: number|null,
 *   top_agent_id: string|null, top_agent_name: string|null,
 *   top_agent_spend_usdc: number|null, signal: string, headline: string|null,
 *   confidence: number, leaderboard: Array<object>
 * }}
 */
export function classifyLeaderboard(r) {
	const o = r || {};
	const rows = Array.isArray(o.leaderboard) ? o.leaderboard : [];
	const top = rows[0] || null;
	const totalSpend = num(o.total_spend_usdc);
	const topSpend = top ? num(top.spend_usdc) : null;
	return {
		topic: 'agent_leaderboard',
		report: 'agent_leaderboard',
		window_days: Number.isFinite(o.window_days) ? o.window_days : 7,
		agent_count: rows.length,
		total_spend_usdc: totalSpend,
		top_agent_id: top ? top.agent_id || null : null,
		top_agent_name: top ? top.name || null : null,
		top_agent_spend_usdc: topSpend,
		// A populated leaderboard with real spend is a "live" intel signal; an
		// empty week (no paid hires) is "quiet". Confidence scales with breadth.
		signal: rows.length > 0 ? 'live' : 'quiet',
		headline: top
			? `${top.name || 'Agent'} leads x402 spend at $${(topSpend ?? 0).toFixed(2)} (${rows.length} active)`
			: 'No agent x402 spend recorded this week',
		confidence: Math.min(0.95, 0.5 + rows.length * 0.045),
		leaderboard: rows,
	};
}

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _schemaReady = false;

/**
 * Create the snapshot table if absent. Idempotent; safe to call on every write.
 * @param {Function} sql tagged-template sql client (from api/_lib/db.js)
 */
export async function ensureLeaderboardSchema(sql) {
	if (_schemaReady || !sql) return;
	await sql`
		CREATE TABLE IF NOT EXISTS agent_spend_leaderboard_snapshots (
			id                    bigserial PRIMARY KEY,
			ts                    timestamptz NOT NULL DEFAULT now(),
			run_id                uuid,
			window_days           int,
			agent_count           int,
			total_spend_usdc      double precision,
			top_agent_id          uuid,
			top_agent_name        text,
			top_agent_spend_usdc  double precision,
			leaderboard           jsonb NOT NULL DEFAULT '[]'::jsonb,
			source                text NOT NULL DEFAULT 'x402-autonomous'
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS agent_spend_leaderboard_snapshots_ts_desc
			ON agent_spend_leaderboard_snapshots (ts DESC)
	`;
	_schemaReady = true;
}

/**
 * Append one leaderboard snapshot.
 * @param {Function} sql
 * @param {object} v a classifyLeaderboard() result
 * @param {{ runId?: string, source?: string }} [meta]
 */
export async function insertLeaderboardSnapshot(sql, v, meta = {}) {
	if (!sql || !v) return;
	await ensureLeaderboardSchema(sql);
	// top_agent_id is a uuid column — never insert a non-uuid; null it if absent.
	const topId = typeof v.top_agent_id === 'string' && v.top_agent_id ? v.top_agent_id : null;
	await sql`
		INSERT INTO agent_spend_leaderboard_snapshots
			(ts, run_id, window_days, agent_count, total_spend_usdc,
			 top_agent_id, top_agent_name, top_agent_spend_usdc, leaderboard, source)
		VALUES
			(now(), ${meta.runId || null}, ${v.window_days ?? 7}, ${v.agent_count ?? 0},
			 ${v.total_spend_usdc}, ${topId}, ${v.top_agent_name},
			 ${v.top_agent_spend_usdc},
			 ${JSON.stringify(v.leaderboard || [])}::jsonb,
			 ${meta.source || 'x402-autonomous'})
	`;
}

/**
 * Latest leaderboard snapshot, or null when none exist. Read by partnership
 * outreach tooling to prioritize the highest-value paying agents.
 * @param {Function} sql
 */
export async function getLatestLeaderboard(sql) {
	if (!sql) return null;
	const rows = await sql`
		SELECT ts, run_id, window_days, agent_count, total_spend_usdc,
		       top_agent_id, top_agent_name, top_agent_spend_usdc, leaderboard
		FROM agent_spend_leaderboard_snapshots
		ORDER BY ts DESC
		LIMIT 1
	`;
	return rows[0] || null;
}

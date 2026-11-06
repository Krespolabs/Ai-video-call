// Read-through sources for the channel-feed endpoint.
// Each function reads a Redis list populated by the pumpkit worker.
// Returns [] when Redis is unconfigured or unavailable.

import { getRedis } from './redis.js';

function redis() { return getRedis(); }

function safeJson(s) {
	try { return JSON.parse(s); } catch { return null; }
}

async function readList(key, limit) {
	const r = redis();
	if (!r) return [];
	try {
		const items = await r.lrange(key, 0, Math.max(0, limit - 1));
		return items.map((x) => (typeof x === 'string' ? safeJson(x) : x)).filter(Boolean);
	} catch (err) {
		console.error(`[channel-feed-sources] redis read failed (${key}):`, err?.message || err);
		return [];
	}
}

// pumpkit worker pushes new mint events to pf:mints.
// Shape: { signature, mint, name, symbol, timestamp, ... }
export async function getMints(limit = 50) {
	return readList('pf:mints', limit);
}

// pumpkit worker pushes first whale-buy events to pf:whales.
// Shape: { signature, mint, amount_sol, buyer, timestamp, ... }
export async function getWhales(limit = 50) {
	return readList('pf:whales', limit);
}

// pumpkit worker pushes creator-claim events to pf:claims.
// Shape: { signature, mint, claimer, amount_lamports, timestamp, ... }
export async function getClaims(limit = 50) {
	return readList('pf:claims', limit);
}

// Agent-attributed pump.fun reputation signals, newest-first, sourced from the
// pumpfun_signals rows the pumpfun-signals cron writes (not Redis). Each row is
// joined to the agent it belongs to so the channel feed can render
// "<agent> — graduated a token (+0.3)". Returns [] when the DB is unreachable.
let _sqlPromise = null;
async function getSql() {
	if (!_sqlPromise) _sqlPromise = import('./db.js').then((m) => m.sql).catch(() => null);
	return _sqlPromise;
}

const SIGNAL_LABELS = {
	first_claim: 'first creator-fee claim',
	graduation: 'graduated a token',
	influencer: 'influencer-tier claim',
	whale_buy: 'whale buy',
	launch: 'launched a token',
	new_account: 'new-account claim',
	fake_claim: 'flagged claim',
};

function signalSummary(row) {
	const who =
		row.agent_name ||
		(row.wallet ? `${row.wallet.slice(0, 4)}…${row.wallet.slice(-4)}` : 'an agent');
	const what = SIGNAL_LABELS[row.kind] || String(row.kind || 'signal').replace(/_/g, ' ');
	const w = Number(row.weight);
	const sign = Number.isFinite(w) && w !== 0 ? ` (${w > 0 ? '+' : ''}${w})` : '';
	return `${who} — ${what}${sign}`;
}

export async function getSignals(limit = 50) {
	const sql = await getSql();
	if (!sql) return [];
	const cap = Math.min(Math.max(limit | 0 || 50, 1), 200);
	try {
		const rows = await sql`
			select s.tx_signature, s.kind, s.weight, s.wallet, s.agent_asset,
			       s.payload, s.seen_at,
			       a.id as agent_id, a.name as agent_name
			from pumpfun_signals s
			left join agent_identities a
			       on a.meta->>'sol_mint_address' = s.agent_asset
			      and a.deleted_at is null
			order by s.seen_at desc
			limit ${cap}
		`;
		return rows.map((r) => ({
			// Distinct dedup key so an agent-attributed signal is not collapsed
			// against the raw mint/whale/claim event that shares its tx.
			signature: `signal:${r.tx_signature}:${r.kind}`,
			tx_signature: r.tx_signature,
			mint: r.payload?.mint ?? null,
			name: r.agent_name ?? null,
			symbol: r.payload?.symbol ?? null,
			signal_kind: r.kind,
			weight: Number.isFinite(Number(r.weight)) ? Number(r.weight) : 0,
			wallet: r.wallet ?? null,
			agent_asset: r.agent_asset ?? null,
			agent_id: r.agent_id ?? null,
			agent_name: r.agent_name ?? null,
			summary: signalSummary(r),
			timestamp: r.seen_at ? Math.floor(new Date(r.seen_at).getTime() / 1000) : 0,
			payload: r.payload ?? {},
		}));
	} catch (err) {
		console.error('[channel-feed-sources] signals read failed:', err?.message || err);
		return [];
	}
}

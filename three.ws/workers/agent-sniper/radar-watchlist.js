// agent-sniper — pre-launch radar watchlist builder.
//
// Auto-curates the set of high-signal wallets the radar monitors, from REAL data:
//
//   (a) proven creators — addresses whose launches have graduated >= N times,
//       counted from the coin-intel ground truth (pump_coin_intel ⋈
//       pump_coin_outcomes). These are the wallets whose next deploy is worth
//       racing to block-0.
//   (b) proven smart money — top smart_wallet_reputation addresses (task 03),
//       excluding sybil-labelled wallets. A reputable wallet funding a fresh
//       deploy wallet is itself a launch precursor.
//
// Persists to radar_watchlist (capped, stale-evicted), and exposes loadWatchlist
// for the poll loop. The curation merge is a pure, tested function; the DB read +
// write wrap it. Never throws to the caller — a graph hiccup degrades the
// watchlist's freshness, never the trade path.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';

/**
 * Merge creator-pedigree + smart-money candidates into one capped, scored set.
 * Pure — deterministic given its inputs, so a rerun produces identical rows.
 *
 * @param {object} o
 * @param {Array<{address,graduated,launches}>} o.creators
 * @param {Array<{address,realized_score,labels}>} o.smartMoney
 * @param {number} o.cap
 * @returns {Array<{address,reason,score,creator_graduated,realized_score,labels}>}
 */
export function curateWatchlist({ creators = [], smartMoney = [], cap = 500 }) {
	const byAddr = new Map();

	const bump = (address, patch) => {
		if (!address) return;
		const cur = byAddr.get(address) || { address, reason: null, score: 0, creator_graduated: null, realized_score: null, labels: new Set() };
		if (patch.creator_graduated != null) cur.creator_graduated = Math.max(cur.creator_graduated ?? 0, patch.creator_graduated);
		if (patch.realized_score != null) cur.realized_score = Math.max(cur.realized_score ?? 0, patch.realized_score);
		if (patch.score != null) cur.score = Math.max(cur.score, patch.score);
		if (patch.reason && (!cur.reason || patch.score >= cur.score)) cur.reason = patch.reason;
		for (const l of patch.labels || []) cur.labels.add(l);
		byAddr.set(address, cur);
	};

	for (const c of creators) {
		const graduated = Number(c.graduated) || 0;
		if (graduated <= 0) continue;
		// 50 floor + 10 per graduation, capped at 95 (smart-money proof can push to 100).
		const score = Math.min(95, 50 + graduated * 10);
		bump(c.address, { reason: 'creator_graduated', score, creator_graduated: graduated, labels: ['creator'] });
	}

	for (const s of smartMoney) {
		const rs = Number(s.realized_score) || 0;
		if (rs <= 0) continue;
		const labels = Array.isArray(s.labels) ? s.labels.filter(Boolean) : [];
		bump(s.address, { reason: 'smart_money', score: rs, realized_score: rs, labels: ['smart_money', ...labels] });
	}

	return [...byAddr.values()]
		.map((r) => ({
			address: r.address,
			reason: r.reason || 'creator_graduated',
			score: Math.round(r.score * 100) / 100,
			creator_graduated: r.creator_graduated,
			realized_score: r.realized_score,
			labels: [...r.labels],
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, cap));
}

/**
 * Recompute + persist the watchlist for a network. Idempotent.
 * @returns {Promise<{ ok:boolean, watched:number, creators:number, smartMoney:number, evicted:number, reason?:string }>}
 */
export async function recomputeWatchlist({ network = 'mainnet', cfg }) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	const minGrad = Math.max(1, cfg?.radarMinCreatorGraduated ?? 2);
	const minScore = Math.max(0, cfg?.radarSmartMoneyMinScore ?? 70);
	const cap = Math.max(1, cfg?.radarMaxWatch ?? 500);

	let creators = [];
	let smartMoney = [];
	try {
		[creators, smartMoney] = await Promise.all([
			sql`
				select i.creator as address,
				       count(*) filter (where coalesce(o.graduated, false)) as graduated,
				       count(*) as launches
				from pump_coin_intel i
				join pump_coin_outcomes o on o.mint = i.mint
				where i.network = ${net} and i.creator is not null
				group by i.creator
				having count(*) filter (where coalesce(o.graduated, false)) >= ${minGrad}
				order by graduated desc
				limit ${cap}
			`,
			sql`
				select address, realized_score, labels
				from smart_wallet_reputation
				where network = ${net}
				  and realized_score >= ${minScore}
				  and trades_seen >= 3
				  and not (labels @> array['sybil'])
				order by realized_score desc
				limit ${cap}
			`,
		]);
	} catch (err) {
		log.warn?.('radar watchlist read failed', { err: err?.message });
		return { ok: false, watched: 0, creators: 0, smartMoney: 0, evicted: 0, reason: 'read_failed' };
	}

	const curated = curateWatchlist({ creators, smartMoney, cap });
	if (!curated.length) {
		return { ok: true, watched: 0, creators: creators.length, smartMoney: smartMoney.length, evicted: 0, reason: 'no_signal' };
	}

	let evicted = 0;
	try {
		for (const w of curated) {
			await sql`
				insert into radar_watchlist
					(address, network, reason, source, score, creator_graduated, realized_score, labels, refreshed_at)
				values
					(${w.address}, ${net}, ${w.reason}, 'auto', ${w.score},
					 ${w.creator_graduated}, ${w.realized_score}, ${w.labels}, now())
				on conflict (address, network) do update set
					reason            = excluded.reason,
					score             = excluded.score,
					creator_graduated = excluded.creator_graduated,
					realized_score    = excluded.realized_score,
					labels            = excluded.labels,
					-- a manually-pinned wallet keeps its source; auto re-affirms auto.
					source            = case when radar_watchlist.source = 'manual' then 'manual' else 'auto' end,
					refreshed_at      = now()
			`;
		}
		// Evict auto wallets that fell out of the curated set this run and haven't
		// fired a precursor recently — keeps the monitored set lean + high-signal.
		// Manual pins are never evicted.
		const staleCutoffMs = Math.max(2, 2) * Math.max(60_000, cfg?.radarWatchlistRefreshMs ?? 300_000);
		const cutoffIso = new Date(Date.now() - staleCutoffMs).toISOString();
		const [del] = await sql`
			with removed as (
				delete from radar_watchlist
				where network = ${net} and source = 'auto'
				  and refreshed_at < ${cutoffIso}
				  and (last_hit_at is null or last_hit_at < ${cutoffIso})
				returning 1
			)
			select count(*)::int as n from removed
		`;
		evicted = del?.n ?? 0;
	} catch (err) {
		log.warn?.('radar watchlist persist failed', { err: err?.message });
		return { ok: false, watched: curated.length, creators: creators.length, smartMoney: smartMoney.length, evicted, reason: 'persist_failed' };
	}

	return { ok: true, watched: curated.length, creators: creators.length, smartMoney: smartMoney.length, evicted };
}

/**
 * Load the active watchlist for the poll loop. Returns a Map address → row.
 * @returns {Promise<Map<string, object>>}
 */
export async function loadWatchlist(network = 'mainnet', limit = 1000) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	const rows = await sql`
		select address, reason, source, score, creator_graduated, realized_score, labels, last_hit_at
		from radar_watchlist
		where network = ${net}
		order by score desc
		limit ${Math.max(1, Math.min(5000, limit))}
	`;
	return new Map(rows.map((r) => [r.address, r]));
}

/** Record that a watched wallet fired a precursor (drives stale-eviction + UI). */
export async function markWatchlistHit(address, network) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	try {
		await sql`
			update radar_watchlist set last_hit_at = now(), hits = hits + 1
			where address = ${address} and network = ${net}
		`;
	} catch (err) {
		log.warn?.('radar watchlist hit update failed', { address, err: err?.message });
	}
}

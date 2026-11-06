// Smart-Money Wallet Graph — the recompute job.
//
// Joins pump_coin_wallets ⋈ pump_coin_outcomes to give every wallet a realized
// track record, and clusters wallets by shared funder (union-find) into sybil
// groups. Maintains smart_wallet_reputation + smart_wallet_clusters. Read by the
// live lookup (api/_lib/smart-money.js) that the firewall, sniper scorer, oracle
// gate, and public API share.
//
// Design constraints (all enforced below):
//   - Idempotent + re-runnable: a coin's wallets fold into reputation exactly once
//     (smart_wallet_folded cursor). cluster_id is the deterministic min-address, so
//     a full rerun produces identical rows.
//   - Batched: respects Neon HTTP limits — bounded SELECTs, chunked multi-row
//     upserts, no statement that scans the whole history at once.
//   - Fire-and-forget vs the live feed: this is a separate process / cron. It never
//     touches the trade path; a failure here degrades the graph's freshness, never
//     a buy.
//
// Run standalone:  SMART_GRAPH=1 node workers/agent-sniper/recompute-wallet-graph.js
// Or from the cron: api/cron/smart-money-graph.js calls recomputeWalletGraph().
//
// Derived ONLY from real observed buys + real outcomes — no curated lists.

import { scoreWallet, clusterByFunder } from './intel/wallet-graph.js';

let _dbPromise = null;
async function getDb() {
	if (_dbPromise) return _dbPromise;
	_dbPromise = import('../../api/_lib/db.js')
		.then((m) => ({ sql: m.sql, sqlValues: m.sqlValues }))
		.catch((err) => { console.warn('[wallet-graph] db import failed:', err?.message); return null; });
	return _dbPromise;
}

const UPSERT_CHUNK = 500;          // rows per multi-row upsert statement (one round-trip each)
const MIN_NET_BUY_LAMPORTS = 0;    // a wallet must be a net buyer to be "in" a coin
const ms = (d) => (d ? new Date(d).getTime() : null);

/**
 * Recompute the whole graph for a network.
 *
 * @param {object} [opts]
 * @param {'mainnet'|'devnet'} [opts.network='mainnet']
 * @param {number} [opts.maxCoins=4000]  cap coins folded per run (Neon-friendly).
 * @returns {Promise<{ ok:boolean, wallets:number, clusters:number, coins:number, ms:number, reason?:string }>}
 */
export async function recomputeWalletGraph({ network = 'mainnet', maxCoins = 4000 } = {}) {
	const started = Date.now();
	const db = await getDb();
	if (!db) return { ok: false, wallets: 0, clusters: 0, coins: 0, ms: 0, reason: 'no_db' };
	const { sql, sqlValues } = db;
	const net = network === 'devnet' ? 'devnet' : 'mainnet';

	// 1) Pull every wallet that net-bought a coin with a FINAL outcome, joined to
	//    that outcome. Only judged coins (outcome <> 'unknown') count toward a track
	//    record. Bounded by maxCoins-worth of distinct mints via the outcome table.
	let rows;
	try {
		rows = await sql`
			select
				w.wallet as address,
				w.mint,
				(w.buy_lamports - w.sell_lamports) as net_buy_lamports,
				w.first_seen_at, w.last_seen_at, w.funder,
				o.outcome, o.ath_multiple
			from pump_coin_outcomes o
			join pump_coin_wallets w on w.mint = o.mint
			where o.outcome is not null and o.outcome <> 'unknown'
			  and w.buy_lamports > w.sell_lamports
			  and o.mint in (
				select mint from pump_coin_outcomes
				where outcome is not null and outcome <> 'unknown'
				order by labeled_at desc
				limit ${Math.max(1, Math.min(20000, maxCoins | 0))}
			  )
		`;
	} catch (err) {
		console.warn('[wallet-graph] join read failed:', err?.message);
		return { ok: false, wallets: 0, clusters: 0, coins: 0, ms: Date.now() - started, reason: 'read_failed' };
	}

	if (!rows.length) {
		return { ok: true, wallets: 0, clusters: 0, coins: 0, ms: Date.now() - started, reason: 'no_judged_coins' };
	}

	// 2) Group rows per wallet → judged-launch list, and collect funder edges +
	//    co-occurrence (which mints each wallet bought) for clustering.
	const perWallet = new Map();      // address → judged[]
	const funderOf = new Map();        // address → funder (last non-null wins)
	const coOccurrence = new Map();     // address → Set(mint)
	const coins = new Set();

	for (const r of rows) {
		const address = r.address;
		if (!address) continue;
		coins.add(r.mint);

		if (!perWallet.has(address)) perWallet.set(address, []);
		perWallet.get(address).push({
			outcome: r.outcome,
			ath_multiple: r.ath_multiple != null ? Number(r.ath_multiple) : null,
			net_buy_lamports: Number(r.net_buy_lamports) || 0,
			first_seen: ms(r.first_seen_at),
			last_seen: ms(r.last_seen_at),
		});

		if (r.funder && !funderOf.has(address)) funderOf.set(address, r.funder);
		if (!coOccurrence.has(address)) coOccurrence.set(address, new Set());
		coOccurrence.get(address).add(r.mint);
	}

	// 3) Score every wallet (pure).
	const repRows = [];
	for (const [address, judged] of perWallet) {
		const s = scoreWallet(judged);
		repRows.push({
			address,
			network: net,
			trades_seen: s.trades_seen,
			winners: s.winners,
			losers: s.losers,
			win_rate: s.win_rate,
			avg_ath_multiple: s.avg_ath_multiple,
			realized_score: s.realized_score,
			labels: s.labels,
			first_seen: s.first_seen != null ? new Date(s.first_seen).toISOString() : null,
			last_seen: s.last_seen != null ? new Date(s.last_seen).toISOString() : null,
		});
	}

	// 4) Cluster by shared funder (pure union-find + co-occurrence confidence).
	const walletFunders = [...perWallet.keys()].map((address) => ({ address, funder: funderOf.get(address) || null }));
	const clusterRows = clusterByFunder(walletFunders, coOccurrence).map((c) => ({ ...c, network: net }));

	// 5) Fold sybil labels back into the reputation rows — a wallet in a
	//    high-confidence cluster is tagged so the live lookup + UI show it.
	const clusterByAddr = new Map(clusterRows.map((c) => [c.address, c]));
	for (const r of repRows) {
		const c = clusterByAddr.get(r.address);
		if (c && c.confidence >= 0.5 && c.size >= 3 && !r.labels.includes('sybil')) {
			r.labels = [...r.labels, 'sybil'];
		}
	}

	// 6) Persist — chunked multi-row upserts (Neon HTTP friendly).
	let wroteWallets = 0;
	let wroteClusters = 0;
	try {
		wroteWallets = await upsertReputation(sql, sqlValues, repRows);
		// Replace this network's clusters wholesale: clustering is global over the
		// judged set, so a stale membership must be cleared, not left behind.
		await sql`delete from smart_wallet_clusters where network = ${net}`;
		wroteClusters = await upsertClusters(sql, sqlValues, clusterRows);
		await markFolded(sql, sqlValues, net, rows);
	} catch (err) {
		console.warn('[wallet-graph] persist failed:', err?.message);
		return { ok: false, wallets: wroteWallets, clusters: wroteClusters, coins: coins.size, ms: Date.now() - started, reason: 'persist_failed' };
	}

	return { ok: true, wallets: wroteWallets, clusters: wroteClusters, coins: coins.size, ms: Date.now() - started };
}

// One multi-row INSERT … VALUES per chunk (a single Neon round-trip) rather than
// one statement per row. `scored_at` is omitted from the tuple — the column
// defaults to now() on insert and is refreshed explicitly in the ON CONFLICT set.
// Keys are unique within repRows (built from a per-address Map), so a multi-row
// upsert never trips Postgres' "cannot affect row a second time" guard.
async function upsertReputation(sql, sqlValues, repRows) {
	let written = 0;
	for (let i = 0; i < repRows.length; i += UPSERT_CHUNK) {
		const chunk = repRows.slice(i, i + UPSERT_CHUNK);
		const values = chunk.map((r) => [
			r.address, r.network, r.trades_seen, r.winners, r.losers, r.win_rate,
			r.avg_ath_multiple, r.realized_score, r.labels, r.first_seen, r.last_seen,
		]);
		await sql`
			insert into smart_wallet_reputation (
				address, network, trades_seen, winners, losers, win_rate,
				avg_ath_multiple, realized_score, labels, first_seen, last_seen
			) values ${sqlValues(values)}
			on conflict (address, network) do update set
				trades_seen = excluded.trades_seen, winners = excluded.winners,
				losers = excluded.losers, win_rate = excluded.win_rate,
				avg_ath_multiple = excluded.avg_ath_multiple,
				realized_score = excluded.realized_score, labels = excluded.labels,
				first_seen = least(smart_wallet_reputation.first_seen, excluded.first_seen),
				last_seen = greatest(smart_wallet_reputation.last_seen, excluded.last_seen),
				scored_at = now()
		`;
		written += chunk.length;
	}
	return written;
}

async function upsertClusters(sql, sqlValues, clusterRows) {
	let written = 0;
	for (let i = 0; i < clusterRows.length; i += UPSERT_CHUNK) {
		const chunk = clusterRows.slice(i, i + UPSERT_CHUNK);
		const values = chunk.map((c) => [
			c.address, c.network, c.cluster_id, c.funder_root, c.size, c.confidence,
		]);
		await sql`
			insert into smart_wallet_clusters (
				address, network, cluster_id, funder_root, size, confidence
			) values ${sqlValues(values)}
			on conflict (address, network) do update set
				cluster_id = excluded.cluster_id, funder_root = excluded.funder_root,
				size = excluded.size, confidence = excluded.confidence, scored_at = now()
		`;
		written += chunk.length;
	}
	return written;
}

// Record the idempotency cursor: every coin folded this run, with the outcome it
// was folded at. Lets an incremental variant skip already-folded coins; the full
// recompute above is itself idempotent regardless. One multi-row upsert per chunk.
async function markFolded(sql, sqlValues, net, rows) {
	const seen = new Map(); // mint → outcome
	for (const r of rows) if (!seen.has(r.mint)) seen.set(r.mint, r.outcome);
	const entries = [...seen.entries()];
	for (let i = 0; i < entries.length; i += UPSERT_CHUNK) {
		const chunk = entries.slice(i, i + UPSERT_CHUNK);
		const values = chunk.map(([mint, outcome]) => [mint, net, outcome]);
		await sql`
			insert into smart_wallet_folded (mint, network, outcome)
			values ${sqlValues(values)}
			on conflict (mint, network) do update set
				outcome = excluded.outcome, folded_at = now()
		`;
	}
}

// ── standalone entrypoint ─────────────────────────────────────────────────────
// Env-gated: SMART_GRAPH=1 enables the loop; SMART_GRAPH_INTERVAL_MS sets cadence
// (default 5 min). Mirrors the worker style — long-lived, batched, never blocks.
function isMain() {
	try {
		return import.meta.url === `file://${process.argv[1]}`;
	} catch {
		return false;
	}
}

async function runLoop() {
	const network = (process.env.SNIPER_NETWORK || 'mainnet').trim() === 'devnet' ? 'devnet' : 'mainnet';
	const intervalMs = Math.max(60_000, Number(process.env.SMART_GRAPH_INTERVAL_MS) || 300_000);
	console.log(`[wallet-graph] starting recompute loop (network=${network}, every ${Math.round(intervalMs / 1000)}s)`);

	let running = true;
	const stop = (sig) => { console.log(`[wallet-graph] ${sig} — stopping`); running = false; };
	process.on('SIGINT', () => stop('SIGINT'));
	process.on('SIGTERM', () => stop('SIGTERM'));

	while (running) {
		try {
			const r = await recomputeWalletGraph({ network });
			console.log('[wallet-graph] recompute', r);
		} catch (err) {
			console.warn('[wallet-graph] recompute crashed:', err?.message);
		}
		// Sleep in short slices so a SIGTERM mid-interval exits promptly.
		const wakeAt = Date.now() + intervalMs;
		while (running && Date.now() < wakeAt) {
			await new Promise((res) => setTimeout(res, Math.min(1000, wakeAt - Date.now())));
		}
	}
	process.exit(0);
}

if (isMain()) {
	if (!/^(1|true|yes|on)$/i.test(String(process.env.SMART_GRAPH || ''))) {
		console.error('[wallet-graph] refusing to start: set SMART_GRAPH=1 to enable the recompute loop');
		process.exit(1);
	}
	runLoop().catch((err) => { console.error('[wallet-graph] fatal:', err?.message); process.exit(1); });
}

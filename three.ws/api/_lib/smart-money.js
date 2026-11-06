// Smart-Money live lookup — the read layer over the wallet reputation graph.
//
// The recompute job (workers/agent-sniper/recompute-wallet-graph.js) maintains
// smart_wallet_reputation + smart_wallet_clusters from real observed buys ⋈ real
// outcomes. THIS module is the hot read path every live consumer shares:
//
//   - getSmartMoneyForMint(mint, network) — who reputable is net-buying this coin
//     right now, a 0..100 smart_money_score, and a sybil_flag when the buyers are
//     dominated by one funder cluster. Read by the firewall, the sniper scorer,
//     the oracle gate, and the public API.
//   - getWalletReputation(address, network) — one wallet's realized track record.
//
// Honest degradation is the rule (mirrors trade-firewall.js): when DATABASE_URL
// is absent, the graph hasn't been computed, or a query fails, every function
// resolves to a well-formed zero-data result — it NEVER throws and never blocks a
// caller. A caller can always tell "no data" from "bad coin" by the count/score.
//
// Derived ONLY from on-chain addresses + observed outcomes. No hand-curated lists,
// no invented trader names. $THREE is the only coin three.ws promotes; this is
// coin-agnostic analytics over whatever runtime mint a caller hands it.

// Lazy DB import so this module loads in dev/test without DATABASE_URL.
let _sqlPromise = null;
async function getSql() {
	if (_sqlPromise) return _sqlPromise;
	_sqlPromise = import('./db.js')
		.then((m) => m.sql)
		.catch((err) => { console.warn('[smart-money] db import failed:', err?.message); return null; });
	return _sqlPromise;
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const lamportsToSol = (v) => {
	try { return Math.round((Number(BigInt(v ?? 0)) / 1e9) * 1000) / 1000; } catch { return num(v) / 1e9; }
};

// ── brief caches ──────────────────────────────────────────────────────────────
// The firewall + scorer can hit the same fresh mint many times in a burst, and the
// public API caches at the edge too — a few seconds here shaves real DB latency.
const MINT_TTL_MS = 12_000;
const WALLET_TTL_MS = 30_000;
const _mintCache = new Map(); // `${network}:${mint}` → { at, value }
const _walletCache = new Map(); // `${network}:${address}` → { at, value }

function cacheGet(map, key, ttl) {
	const hit = map.get(key);
	if (!hit) return undefined;
	if (Date.now() - hit.at > ttl) { map.delete(key); return undefined; }
	return hit.value;
}
function cacheSet(map, key, value, limit = 4_000) {
	map.set(key, { at: Date.now(), value });
	if (map.size > limit) {
		const drop = Math.floor(limit / 4);
		const it = map.keys();
		for (let i = 0; i < drop; i++) map.delete(it.next().value);
	}
}

// A wallet counts as "smart money" in a coin when it has a real, proven track
// record. We pull reputable buyers directly from the reputation graph join.
const PROVEN_SCORE = 70;
const STRONG_SCORE = 55;

/** Empty, well-formed result — the honest zero-data shape. */
function emptyMintResult(mint, network) {
	return {
		mint,
		network,
		smart_money_score: 0,
		count: 0,
		total_buyers: 0,
		wallets: [],
		clusters: [],
		sybil_flag: false,
		sybil_share: 0,
		computed: false, // false = no graph data yet (UI shows "not enough history")
	};
}

/**
 * Reputable buyers currently net-buying a mint, plus a sybil read.
 *
 * @param {string} mint
 * @param {'mainnet'|'devnet'} [network='mainnet']
 * @returns {Promise<{
 *   mint:string, network:string, smart_money_score:number, count:number,
 *   total_buyers:number,
 *   wallets:Array<{address:string, realized_score:number, win_rate:number,
 *                  avg_ath_multiple:number, labels:string[], buy_sol:number,
 *                  cluster_id:string|null, sybil:boolean}>,
 *   clusters:Array<{cluster_id:string, size:number, confidence:number, buyers:number,
 *                   buy_sol:number, funder_root:string|null}>,
 *   sybil_flag:boolean, sybil_share:number, computed:boolean
 * }>}
 */
export async function getSmartMoneyForMint(mint, network = 'mainnet') {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	if (!mint || typeof mint !== 'string') return emptyMintResult(mint, net);

	const key = `${net}:${mint}`;
	const cached = cacheGet(_mintCache, key, MINT_TTL_MS);
	if (cached !== undefined) return cached;

	const sql = await getSql();
	if (!sql) { const r = emptyMintResult(mint, net); cacheSet(_mintCache, key, r); return r; }

	let rows;
	try {
		// Join every wallet that net-bought this coin against its reputation + cluster.
		// net_buy = buy_lamports - sell_lamports, floored at 0: a wallet that fully
		// dumped is not "in" the coin. Reputation/cluster are LEFT joins so unscored
		// buyers still inform the total + cluster dominance.
		rows = await sql`
			select
				w.wallet as address,
				(w.buy_lamports - w.sell_lamports) as net_buy_lamports,
				r.realized_score, r.win_rate, r.avg_ath_multiple, r.labels, r.trades_seen,
				c.cluster_id, c.confidence as cluster_confidence, c.size as cluster_size,
				c.funder_root
			from pump_coin_wallets w
			left join smart_wallet_reputation r
				on r.address = w.wallet and r.network = ${net}
			left join smart_wallet_clusters c
				on c.address = w.wallet and c.network = ${net}
			where w.mint = ${mint}
			  and w.buy_lamports > w.sell_lamports
			order by net_buy_lamports desc
			limit 200
		`;
	} catch (err) {
		console.warn('[smart-money] mint lookup failed:', err?.message);
		const r = emptyMintResult(mint, net);
		cacheSet(_mintCache, key, r);
		return r;
	}

	const result = shapeMint(mint, net, rows);
	cacheSet(_mintCache, key, result);
	return result;
}

function shapeMint(mint, network, rows) {
	if (!Array.isArray(rows) || rows.length === 0) {
		return emptyMintResult(mint, network);
	}
	const totalBuyers = rows.length;
	let totalNet = 0;
	const clusterAgg = new Map(); // cluster_id → { size, confidence, funder_root, buyers, net }

	const wallets = rows.map((row) => {
		const net = Math.max(0, num(row.net_buy_lamports));
		totalNet += net;
		const labels = Array.isArray(row.labels) ? row.labels : [];
		const clusterId = row.cluster_id || null;
		if (clusterId) {
			let agg = clusterAgg.get(clusterId);
			if (!agg) {
				agg = { size: num(row.cluster_size, 0), confidence: num(row.cluster_confidence, 0), funder_root: row.funder_root || null, buyers: 0, net: 0 };
				clusterAgg.set(clusterId, agg);
			}
			agg.buyers++;
			agg.net += net;
		}
		return {
			address: row.address,
			realized_score: num(row.realized_score, 0),
			win_rate: num(row.win_rate, 0),
			avg_ath_multiple: num(row.avg_ath_multiple, 0),
			labels,
			trades_seen: num(row.trades_seen, 0),
			buy_sol: lamportsToSol(net),
			cluster_id: clusterId,
			sybil: false, // set below once dominance is known
		};
	});

	// Reputable buyers: proven track record (score >= STRONG and a real sample).
	const reputable = wallets.filter((w) => w.realized_score >= STRONG_SCORE && w.trades_seen >= 3);
	const proven = reputable.filter((w) => w.realized_score >= PROVEN_SCORE);

	// Smart-money score for the COIN: net-buy-weighted mean reputation of reputable
	// buyers, lifted by how many proven wallets are in. Mirrors the pedigree intent
	// of the oracle without duplicating its fusion. 0 when nobody reputable is in.
	let smartScore = 0;
	if (reputable.length) {
		// Net-buy-weighted mean reputation: a proven wallet putting in size counts
		// more than one dust-buying. A tiny epsilon weight keeps zero-SOL rows valid.
		const weighted = reputable.reduce((s, w) => s + w.realized_score * (w.buy_sol || 0.0001), 0);
		const denom = reputable.reduce((s, w) => s + (w.buy_sol || 0.0001), 0) || 1;
		smartScore = weighted / denom;
		if (proven.length >= 5) smartScore += 12;
		else if (proven.length >= 3) smartScore += 8;
		else if (proven.length >= 1) smartScore += 4;
		smartScore = Math.round(Math.max(0, Math.min(100, smartScore)));
	}

	// Sybil dominance: the largest funder cluster's share of total net-buy volume.
	// When one cluster owns the book, the "wide base" is one funder wearing wallets.
	let topClusterShare = 0;
	let topClusterId = null;
	for (const [cid, agg] of clusterAgg) {
		const share = totalNet > 0 ? agg.net / totalNet : 0;
		if (share > topClusterShare) { topClusterShare = share; topClusterId = cid; }
	}
	const sybilFlag = topClusterShare >= 0.5 && (clusterAgg.get(topClusterId)?.buyers || 0) >= 3;
	if (sybilFlag) {
		for (const w of wallets) if (w.cluster_id === topClusterId) w.sybil = true;
	}

	const clusters = [...clusterAgg.entries()]
		.map(([cluster_id, agg]) => ({
			cluster_id,
			size: agg.size,
			confidence: Number(agg.confidence.toFixed(3)),
			buyers: agg.buyers,
			buy_sol: lamportsToSol(agg.net),
			funder_root: agg.funder_root,
			share: totalNet > 0 ? Number((agg.net / totalNet).toFixed(3)) : 0,
		}))
		.sort((a, b) => b.share - a.share);

	// Surface the reputable wallets first; trim sybil-flagged ones out of the headline
	// "count" (the spec's reputable, non-clustered cohort) but keep them in clusters[].
	const headline = reputable
		.filter((w) => !w.sybil)
		.sort((a, b) => b.realized_score - a.realized_score || b.buy_sol - a.buy_sol);

	return {
		mint,
		network,
		smart_money_score: smartScore,
		count: headline.length,
		total_buyers: totalBuyers,
		wallets: headline.slice(0, 25),
		clusters: clusters.slice(0, 10),
		sybil_flag: sybilFlag,
		sybil_share: Number(topClusterShare.toFixed(3)),
		computed: true,
	};
}

/** Empty, well-formed wallet result. */
function emptyWalletResult(address, network) {
	return {
		address,
		network,
		realized_score: 0,
		win_rate: 0,
		avg_ath_multiple: 0,
		trades_seen: 0,
		winners: 0,
		losers: 0,
		labels: [],
		cluster: null,
		first_seen: null,
		last_seen: null,
		scored_at: null,
		computed: false,
	};
}

/**
 * One wallet's realized reputation + its cluster membership.
 *
 * @param {string} address
 * @param {'mainnet'|'devnet'} [network='mainnet']
 * @returns {Promise<object>} the reputation row shaped for callers; computed:false
 *   when the wallet has no track record yet (or the graph isn't available).
 */
export async function getWalletReputation(address, network = 'mainnet') {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	if (!address || typeof address !== 'string') return emptyWalletResult(address, net);

	const key = `${net}:${address}`;
	const cached = cacheGet(_walletCache, key, WALLET_TTL_MS);
	if (cached !== undefined) return cached;

	const sql = await getSql();
	if (!sql) { const r = emptyWalletResult(address, net); cacheSet(_walletCache, key, r); return r; }

	let rep, cluster;
	try {
		[rep, cluster] = await Promise.all([
			sql`
				select address, realized_score, win_rate, avg_ath_multiple, trades_seen,
				       winners, losers, labels, first_seen, last_seen, scored_at
				from smart_wallet_reputation
				where address = ${address} and network = ${net}
				limit 1
			`.then((r) => r[0] || null),
			sql`
				select cluster_id, funder_root, size, confidence
				from smart_wallet_clusters
				where address = ${address} and network = ${net}
				limit 1
			`.then((r) => r[0] || null),
		]);
	} catch (err) {
		console.warn('[smart-money] wallet lookup failed:', err?.message);
		const r = emptyWalletResult(address, net);
		cacheSet(_walletCache, key, r);
		return r;
	}

	if (!rep) { const r = emptyWalletResult(address, net); cacheSet(_walletCache, key, r); return r; }

	const result = {
		address: rep.address,
		network: net,
		realized_score: num(rep.realized_score, 0),
		win_rate: num(rep.win_rate, 0),
		avg_ath_multiple: num(rep.avg_ath_multiple, 0),
		trades_seen: num(rep.trades_seen, 0),
		winners: num(rep.winners, 0),
		losers: num(rep.losers, 0),
		labels: Array.isArray(rep.labels) ? rep.labels : [],
		cluster: cluster
			? {
				cluster_id: cluster.cluster_id,
				funder_root: cluster.funder_root || null,
				size: num(cluster.size, 1),
				confidence: num(cluster.confidence, 0),
			}
			: null,
		first_seen: rep.first_seen || null,
		last_seen: rep.last_seen || null,
		scored_at: rep.scored_at || null,
		computed: true,
	};
	cacheSet(_walletCache, key, result);
	return result;
}

/** Clear the in-process caches (used by tests + the recompute job after a write). */
export function _resetSmartMoneyCache() {
	_mintCache.clear();
	_walletCache.clear();
}

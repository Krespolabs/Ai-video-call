// Coin Intelligence — persistence + hot-path cache.
//
// The sniper reads intel on the buy decision path, so reads must be instant:
// an in-process Map serves the worker with zero I/O. Writes upsert into
// pump_coin_intel + pump_coin_wallets (fire-and-forget — a DB hiccup never
// blocks the feed). Cross-process consumers (the API, other workers) read from
// Postgres. The DB import is lazy so dev/test without DATABASE_URL still loads.

import { isQuoteMint } from '../../../api/_lib/quote-mints.js';

let _sqlPromise = null;
async function getSql() {
	if (_sqlPromise) return _sqlPromise;
	_sqlPromise = import('../../../api/_lib/db.js')
		.then((m) => m.sql)
		.catch((err) => { console.warn('[coin-intel] db import failed:', err?.message); return null; });
	return _sqlPromise;
}

// ── hot-path cache ───────────────────────────────────────────────────────────
const CACHE_LIMIT = 5_000;
const CACHE_TTL_MS = 30 * 60_000; // 30 min — coins are only interesting fresh
const _cache = new Map(); // mint -> { record, at }

export function cacheGet(mint) {
	const hit = _cache.get(mint);
	if (!hit) return null;
	if (Date.now() - hit.at > CACHE_TTL_MS) { _cache.delete(mint); return null; }
	return hit.record;
}

export function cacheSet(mint, record) {
	_cache.set(mint, { record, at: Date.now() });
	if (_cache.size > CACHE_LIMIT) {
		const drop = Math.floor(CACHE_LIMIT / 4);
		const it = _cache.keys();
		for (let i = 0; i < drop; i++) _cache.delete(it.next().value);
	}
}

/** Newest-first snapshot of cached intel — used as a feed fallback in dev. */
export function cacheRecent(limit = 50) {
	const out = [];
	for (const { record } of _cache.values()) out.push(record);
	out.sort((a, b) => (b.first_seen_at_ms || 0) - (a.first_seen_at_ms || 0));
	return out.slice(0, limit);
}

const big = (v) => (v == null ? null : String(BigInt(Math.round(Number(v) || 0))));

/**
 * Persist a finished intel record + its per-wallet ledger. Idempotent upsert.
 * @param {object} rec  the record assembled by watcher.js
 * @param {Map} walletAgg  wallet -> aggregate (from computeSignals)
 */
export async function persistIntel(rec, walletAgg) {
	// Quote/stablecoin/LST mints (USDC, USDT, wSOL, …) are the swap counter-side,
	// never a launched coin. Drop them at the root so they never pollute the brain.
	if (isQuoteMint(rec.mint)) return;
	cacheSet(rec.mint, rec);
	const sql = await getSql();
	if (!sql) return;

	const s = rec.signals || {};
	const notableJson = JSON.stringify(rec.smart_money_notable || []);
	try {
		await sql`
			insert into pump_coin_intel (
				mint, network, symbol, name, creator, bonding_curve, image_uri, description,
				twitter, telegram, website, created_at, first_seen_at, observation_ended_at,
				observation_seconds, dev_buy_lamports, dev_sold, dev_sell_lamports,
				buy_count, sell_count, buy_volume_lamports, sell_volume_lamports,
				unique_buyers, unique_sellers, largest_buy_lamports,
				signals, bundle_score, organic_score, snipe_ratio, concentration_top10,
				fresh_wallet_ratio, bubblemap_connectivity, quality_score, risk_flags,
				category, tags, narrative, is_news_meme, classify_confidence, classify_source,
				smart_money_count, smart_money_score, smart_money_notable,
				cluster_count, updated_at
			) values (
				${rec.mint}, ${rec.network || 'mainnet'}, ${rec.symbol || null}, ${rec.name || null},
				${rec.creator || null}, ${rec.bonding_curve || null}, ${rec.image_uri || null}, ${rec.description || null},
				${rec.twitter || null}, ${rec.telegram || null}, ${rec.website || null},
				to_timestamp(${rec.created_at_sec || null}), now(), now(),
				${s.window_seconds ?? null}, ${big(rec.dev_buy_lamports)}, ${!!s.dev_sold}, ${big(rec.dev_sell_lamports)},
				${s.buy_count ?? 0}, ${s.sell_count ?? 0}, ${big(rec.buy_volume_lamports)}, ${big(rec.sell_volume_lamports)},
				${s.unique_buyers ?? 0}, ${s.unique_sellers ?? 0}, ${big(rec.largest_buy_lamports)},
				${JSON.stringify(s)}::jsonb, ${s.bundle_score ?? null}, ${s.organic_score ?? null},
				${s.snipe_ratio ?? null}, ${s.concentration_top10 ?? null},
				${s.fresh_wallet_ratio ?? null}, ${rec.bubblemap_connectivity ?? s.bubblemap_connectivity ?? null},
				${rec.quality_score ?? null}, ${rec.risk_flags || []},
				${rec.category || null}, ${rec.tags || []}, ${rec.narrative || null},
				${!!rec.is_news_meme}, ${rec.classify_confidence ?? null}, ${rec.classify_source || null},
				${rec.smart_money_count ?? 0}, ${rec.smart_money_score ?? null}, ${notableJson}::jsonb,
				${rec.cluster_count ?? 0}, now()
			)
			on conflict (mint) do update set
				symbol = excluded.symbol, name = excluded.name,
				observation_ended_at = excluded.observation_ended_at,
				observation_seconds = excluded.observation_seconds,
				dev_buy_lamports = excluded.dev_buy_lamports, dev_sold = excluded.dev_sold,
				dev_sell_lamports = excluded.dev_sell_lamports,
				buy_count = excluded.buy_count, sell_count = excluded.sell_count,
				buy_volume_lamports = excluded.buy_volume_lamports,
				sell_volume_lamports = excluded.sell_volume_lamports,
				unique_buyers = excluded.unique_buyers, unique_sellers = excluded.unique_sellers,
				largest_buy_lamports = excluded.largest_buy_lamports,
				signals = excluded.signals, bundle_score = excluded.bundle_score,
				organic_score = excluded.organic_score, snipe_ratio = excluded.snipe_ratio,
				concentration_top10 = excluded.concentration_top10,
				fresh_wallet_ratio = excluded.fresh_wallet_ratio,
				bubblemap_connectivity = excluded.bubblemap_connectivity,
				quality_score = excluded.quality_score, risk_flags = excluded.risk_flags,
				category = excluded.category, tags = excluded.tags, narrative = excluded.narrative,
				is_news_meme = excluded.is_news_meme,
				classify_confidence = excluded.classify_confidence,
				classify_source = excluded.classify_source,
				smart_money_count = excluded.smart_money_count,
				smart_money_score = excluded.smart_money_score,
				smart_money_notable = excluded.smart_money_notable,
				cluster_count = excluded.cluster_count,
				updated_at = now()
		`;
	} catch (err) {
		console.warn('[coin-intel] persist intel failed:', err?.message);
	}

	if (walletAgg && walletAgg.size) await persistWallets(sql, rec.mint, rec.creator, walletAgg);
}

async function persistWallets(sql, mint, creator, walletAgg) {
	// Build a single multi-row upsert. Cap rows to keep statements bounded — the
	// top traders by activity are what concentration/bubblemap care about.
	const rows = [...walletAgg.entries()]
		.sort((a, b) => (b[1].buyLamports + b[1].sellLamports) - (a[1].buyLamports + a[1].sellLamports))
		.slice(0, 200);
	let failed = 0;
	for (const [wallet, w] of rows) {
		// funder is written by the funding-graph enrichment step in watcher.js
		const funder = w.funder || null;
		try {
			await sql`
				insert into pump_coin_wallets (
					mint, wallet, buy_count, sell_count, buy_lamports, sell_lamports,
					base_bought, base_sold, first_seen_at, last_seen_at, is_creator, funder
				) values (
					${mint}, ${wallet}, ${w.buyCount}, ${w.sellCount},
					${big(w.buyLamports)}, ${big(w.sellLamports)},
					${big(w.baseBought)}, ${big(w.baseSold)},
					to_timestamp(${Math.floor(w.firstTs / 1000)}), to_timestamp(${Math.floor(w.lastTs / 1000)}),
					${wallet === creator}, ${funder}
				)
				on conflict (mint, wallet) do update set
					buy_count = excluded.buy_count, sell_count = excluded.sell_count,
					buy_lamports = excluded.buy_lamports, sell_lamports = excluded.sell_lamports,
					base_bought = excluded.base_bought, base_sold = excluded.base_sold,
					last_seen_at = excluded.last_seen_at,
					funder = coalesce(excluded.funder, pump_coin_wallets.funder)
			`;
		} catch (err) {
			failed++;
			if (failed === 1) console.warn('[coin-intel] persist wallet row failed:', err?.message);
		}
	}
	if (failed > 0) console.warn(`[coin-intel] persist wallets: ${failed}/${rows.length} rows failed for mint ${mint}`);
}

/** Read one coin's intel — cache first, then DB. */
export async function readIntel(mint) {
	const cached = cacheGet(mint);
	if (cached) return cached;
	const sql = await getSql();
	if (!sql) return null;
	try {
		const [row] = await sql`select * from pump_coin_intel where mint = ${mint} limit 1`;
		return row || null;
	} catch (err) {
		console.warn('[coin-intel] read intel failed:', err?.message);
		return null;
	}
}

/** Read the live radar feed (newest first), with optional filters. */
export async function readRecent({ limit = 50, minQuality = null, category = null, network = 'mainnet' } = {}) {
	const cap = Math.max(1, Math.min(200, limit | 0 || 50));
	const sql = await getSql();
	if (!sql) return cacheRecent(cap);
	try {
		const rows = await sql`
			select * from pump_coin_intel
			where network = ${network}
			  and (${minQuality}::int is null or quality_score >= ${minQuality})
			  and (${category}::text is null or category = ${category})
			order by first_seen_at desc
			limit ${cap}
		`;
		return rows;
	} catch (err) {
		console.warn('[coin-intel] read recent failed:', err?.message);
		return cacheRecent(cap);
	}
}

// ── learned weights (read by scorer; written by learn.js) ────────────────────
let _weights = null;
let _weightsAt = 0;
const WEIGHTS_TTL_MS = 5 * 60_000;

export async function getLearnedWeights(network = 'mainnet') {
	if (_weights && Date.now() - _weightsAt < WEIGHTS_TTL_MS) return _weights;
	const sql = await getSql();
	if (!sql) return null;
	try {
		const [row] = await sql`
			select weights, sample_size from pump_intel_weights
			where network = ${network} order by trained_at desc limit 1
		`;
		_weights = row?.weights || null;
		_weightsAt = Date.now();
		return _weights;
	} catch {
		return null;
	}
}

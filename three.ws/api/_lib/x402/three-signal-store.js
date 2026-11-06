// api/_lib/x402/three-signal-store.js
//
// Time-series store for the $THREE Signal Feed.
//
// The x402 autonomous loop pays /api/x402/three-intel every 15 minutes (registry
// entry `three-intel`) and appends the live $THREE market snapshot here. This
// table is the historical record behind two consumers:
//
//   1. The public $THREE price widget — GET /api/three-signal reads the latest
//      point plus a short sparkline history from here (no payment needed to
//      *display* a price the platform already paid to fetch).
//   2. $THREE-denominated x402 pricing — usdToThreeTokens() converts a USDC
//      amount into $THREE token units using the latest stored price, so callers
//      can quote any endpoint's fee in $THREE without re-fetching the market.
//
// Schema ownership lives here so the writer (registry storeValue) and the reader
// (the endpoint) can never disagree on shape. ensureThreeSignalSchema() mirrors
// the idempotent CREATE-IF-NOT-EXISTS idiom the autonomous loop uses elsewhere;
// the canonical DDL is also in api/_lib/migrations/20260627120000_three_market_signals.sql.

import { env } from '../env.js';

// $THREE mint + on-chain decimals (pump.fun mints are 6-decimal).
const THREE_MINT = env.THREE_TOKEN_MINT;
const THREE_DECIMALS = 6;

function num(v) {
	const n = typeof v === 'string' ? parseFloat(v) : v;
	return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a /api/x402/three-intel response into the time-series row shape.
 * Shared by the registry's extractSignal (→ x402_autonomous_log.signal_data) and
 * storeValue (→ three_market_signals) so both always agree on the snapshot.
 *
 * @param {object|null} r raw three-intel JSON response
 * @returns {{
 *   mint: string|null, symbol: string|null, price_usd: number|null,
 *   change_24h: number|null, market_cap_usd: number|null, liquidity_usd: number|null,
 *   volume_24h_usd: number|null, signal: string|null, headline: string|null,
 *   confidence: number|null, ts: string|null
 * }}
 */
export function classifyThreeSignal(r) {
	const o = r || {};
	return {
		mint: o.mint || THREE_MINT || null,
		symbol: o.symbol || 'THREE',
		price_usd: num(o.price_usd),
		change_24h: num(o.change_24h),
		market_cap_usd: num(o.market_cap_usd),
		liquidity_usd: num(o.liquidity_usd),
		volume_24h_usd: num(o.volume_24h_usd),
		signal: typeof o.signal === 'string' ? o.signal : null,
		headline: typeof o.headline === 'string' ? o.headline : null,
		confidence: num(o.confidence),
		ts: typeof o.ts === 'string' ? o.ts : null,
	};
}

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _schemaReady = false;

/**
 * Create the time-series table if absent. Idempotent and safe to call on every
 * write; the in-process guard avoids re-issuing the DDL after the first call.
 * @param {Function} sql tagged-template sql client (from api/_lib/db.js)
 */
export async function ensureThreeSignalSchema(sql) {
	if (_schemaReady || !sql) return;
	await sql`
		CREATE TABLE IF NOT EXISTS three_market_signals (
			id              bigserial PRIMARY KEY,
			ts              timestamptz NOT NULL DEFAULT now(),
			mint            text,
			symbol          text,
			price_usd       double precision,
			change_24h      double precision,
			market_cap_usd  double precision,
			liquidity_usd   double precision,
			volume_24h_usd  double precision,
			signal          text,
			headline        text,
			confidence      double precision,
			run_id          uuid,
			source          text NOT NULL DEFAULT 'x402-autonomous'
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS three_market_signals_ts_desc
			ON three_market_signals (ts DESC)
	`;
	_schemaReady = true;
}

/**
 * Append one market snapshot to the time series.
 * @param {Function} sql
 * @param {object} v a classifyThreeSignal() result
 * @param {{ runId?: string, source?: string }} [meta]
 */
export async function insertThreeSignal(sql, v, meta = {}) {
	if (!sql || !v) return;
	await ensureThreeSignalSchema(sql);
	await sql`
		INSERT INTO three_market_signals
			(ts, mint, symbol, price_usd, change_24h, market_cap_usd,
			 liquidity_usd, volume_24h_usd, signal, headline, confidence, run_id, source)
		VALUES
			(now(), ${v.mint}, ${v.symbol}, ${v.price_usd}, ${v.change_24h},
			 ${v.market_cap_usd}, ${v.liquidity_usd}, ${v.volume_24h_usd},
			 ${v.signal}, ${v.headline}, ${v.confidence},
			 ${meta.runId || null}, ${meta.source || 'x402-autonomous'})
	`;
}

/**
 * Latest stored $THREE snapshot, or null when the series is empty.
 * @param {Function} sql
 */
export async function getLatestThreeSignal(sql) {
	if (!sql) return null;
	const rows = await sql`
		SELECT mint, symbol, price_usd, change_24h, market_cap_usd, liquidity_usd,
		       volume_24h_usd, signal, headline, confidence, ts
		FROM three_market_signals
		ORDER BY ts DESC
		LIMIT 1
	`;
	return rows[0] || null;
}

/**
 * Recent snapshots oldest→newest for a sparkline. Capped at 500 points.
 * @param {Function} sql
 * @param {number} [limit=48] points to return (default ~12 h at 15 min spacing)
 */
export async function getThreeSignalHistory(sql, limit = 48) {
	if (!sql) return [];
	const n = Math.max(1, Math.min(500, Number(limit) || 48));
	const rows = await sql`
		SELECT ts, price_usd, change_24h, signal
		FROM three_market_signals
		ORDER BY ts DESC
		LIMIT ${n}
	`;
	return rows.reverse();
}

/**
 * Convert a USD amount into $THREE token units using a known price.
 * Pure — the caller supplies the latest price (from getLatestThreeSignal) so the
 * conversion is testable and never makes its own network/DB call.
 *
 * @param {number} usd amount in US dollars
 * @param {number|null} priceUsd latest $THREE price in USD
 * @returns {{ tokens: number, atomics: number }|null} null when price is unusable
 */
export function usdToThreeTokens(usd, priceUsd) {
	const amount = num(usd);
	const price = num(priceUsd);
	if (amount == null || price == null || price <= 0) return null;
	const tokens = amount / price;
	return {
		tokens,
		atomics: Math.round(tokens * 10 ** THREE_DECIMALS),
	};
}

export { THREE_MINT, THREE_DECIMALS };

// Token snapshot composition for the free Crypto Data API (/api/crypto/token).
//
// One call answers "what is this token's current market state?" for a trading or
// research agent that holds a contract address and must decide buy / alert /
// ignore. It wraps the existing readers rather than reimplementing them:
//   - DexScreener via fetchTokenMarket (token-market.js) — price / liquidity /
//     mcap / volume / 24 h change, any chain DexScreener indexes, keyless.
//   - pump.fun via fetchPumpCoin (pump-bonding.js) — keyless fallback identity +
//     market cap for Solana mints with no DEX pair yet (fresh bonding-curve
//     launches are exactly the tokens an agent asks about first).
//   - Helius DAS via getMetadataForMints (token-metadata.js) — name/symbol
//     enrichment for non-pump SPL mints, only when a HELIUS_API_KEY exists;
//     degrades to null fields, never fakes.
//
// The composition is dependency-injectable so every path — full data, thin data,
// each upstream down — is unit-testable with synthetic fixtures and no network.

import { fetchTokenMarket, chainOf } from './token-market.js';
import { fetchPumpCoin, mapBondingStatus } from './pump-bonding.js';
import { getMetadataForMints } from './token-metadata.js';

// The stable public contract: every response carries exactly these keys, and a
// field that couldn't be resolved is null — never omitted, never fabricated.
export const SNAPSHOT_FIELDS = [
	'address', 'chain', 'name', 'symbol', 'priceUsd', 'change24h', 'marketCapUsd',
	'liquidityUsd', 'volume24hUsd', 'fdvUsd', 'pairCreatedAt', 'dexId', 'url',
];

/** All-null snapshot skeleton — the shape every merge below fills into. */
export function emptySnapshot(address, chain) {
	const snap = {};
	for (const k of SNAPSHOT_FIELDS) snap[k] = null;
	snap.address = address;
	snap.chain = chain ?? null;
	return snap;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Map a fetchTokenMarket() result onto the stable snapshot shape. */
export function snapshotFromMarket(address, m) {
	const snap = emptySnapshot(address, m.chain);
	snap.name = m.name ?? null;
	snap.symbol = m.symbol ?? null;
	snap.priceUsd = num(m.price_usd);
	snap.change24h = num(m.change_24h);
	snap.marketCapUsd = num(m.market_cap_usd);
	snap.liquidityUsd = num(m.liquidity_usd);
	snap.volume24hUsd = num(m.volume_24h_usd);
	snap.fdvUsd = num(m.fdv_usd);
	snap.pairCreatedAt = m.pair_created_at ? new Date(m.pair_created_at).toISOString() : null;
	snap.dexId = m.dex ?? null;
	snap.url = m.pair_url ?? null;
	return snap;
}

/**
 * Fill a snapshot's null identity/market fields from a raw pump.fun coin object.
 * Only fills gaps — a DexScreener value already present always wins, since the
 * DEX pair is the venue actually pricing the token.
 */
export function mergePumpCoin(snap, coin) {
	if (!coin) return snap;
	if (snap.name == null && coin.name) snap.name = coin.name;
	if (snap.symbol == null && coin.symbol) snap.symbol = coin.symbol;
	if (snap.marketCapUsd == null) {
		snap.marketCapUsd = mapBondingStatus(coin).marketCapUsd;
	}
	if (snap.url == null) snap.url = `https://pump.fun/coin/${snap.address}`;
	if (snap.chain == null) snap.chain = 'solana';
	return snap;
}

/**
 * Is this token-metadata entry the bare placeholder emitted when neither the
 * cache nor Helius could resolve the mint? (bareEntry: symbol/name are the first
 * six chars of the mint, decimals null.) A placeholder must never be surfaced as
 * a real symbol.
 */
export function isBareMeta(meta) {
	if (!meta) return true;
	return meta.decimals == null && meta.symbol === meta.mint?.slice(0, 6);
}

/** Fill null name/symbol from a REAL (non-placeholder) metadata entry. */
export function mergeMeta(snap, meta) {
	if (isBareMeta(meta)) return snap;
	if (snap.name == null && meta.name) snap.name = meta.name;
	if (snap.symbol == null && meta.symbol) snap.symbol = meta.symbol;
	return snap;
}

/**
 * Compose the full snapshot for one address.
 *
 * @param {{ address: string, chain?: string|null }} input `chain` is an optional
 *   DexScreener chainId filter ('solana', 'base', 'ethereum', 'bsc', …).
 * @param {{ fetchMarket?: Function, fetchPump?: Function, fetchMeta?: Function }} [deps]
 *   Injectable upstreams for tests; defaults are the real readers.
 * @returns {Promise<
 *   | { status: 'ok', snapshot: object, sources: string[], note?: string }
 *   | { status: 'not_found' }
 *   | { status: 'upstream_down' }
 * >}
 */
export async function composeTokenSnapshot(
	{ address, chain = null },
	{ fetchMarket = fetchTokenMarket, fetchPump = fetchPumpCoin, fetchMeta = getMetadataForMints } = {},
) {
	const family = chainOf(address); // 'solana' | 'evm' — validated by the caller
	const sources = [];
	const degraded = [];

	let market = null;
	let dexDown = false;
	try {
		market = await fetchMarket(address, { chain });
	} catch {
		dexDown = true;
		degraded.push('dexscreener unavailable');
	}
	if (market) sources.push('dexscreener');

	let snap = market ? snapshotFromMarket(address, market) : emptySnapshot(address, chain);

	// Solana fallback/enrichment: a mint DexScreener doesn't price yet is very
	// often a live pump.fun bonding-curve coin — the keyless coin record supplies
	// identity + market cap. Only consulted when the DEX read left gaps.
	let pump = null;
	if (family === 'solana' && (!market || snap.symbol == null)) {
		pump = await fetchPump(address);
		if (pump.kind === 'ok') {
			snap = mergePumpCoin(snap, pump.coin);
			sources.push('pumpfun');
		} else if (pump.kind === 'upstream_down') {
			degraded.push('pump.fun unavailable');
		}
	}

	// Helius DAS name/symbol enrichment for non-pump SPL mints — best-effort,
	// keyed; a placeholder result is discarded, the fields stay null.
	if (family === 'solana' && snap.symbol == null && (!pump || pump.kind !== 'ok')) {
		try {
			const metaMap = await fetchMeta([address]);
			const meta = metaMap.get(address);
			if (!isBareMeta(meta)) {
				snap = mergeMeta(snap, meta);
				sources.push('helius');
			}
		} catch { /* enrichment only — the snapshot stands without it */ }
	}

	const resolvedAnything = sources.length > 0;
	if (!resolvedAnything) {
		// Nothing answered. If any upstream was actually DOWN we can't distinguish
		// "unknown token" from "source outage" — answer retryable, never a false
		// not-found. Only when every consulted source responded and none knows the
		// address is it genuinely not found.
		const anyDown = dexDown || pump?.kind === 'upstream_down';
		return { status: anyDown ? 'upstream_down' : 'not_found' };
	}

	// Family fallback for the chain field when no source named a concrete chain.
	if (snap.chain == null) snap.chain = family === 'solana' ? 'solana' : (chain || 'evm');

	const result = { status: 'ok', snapshot: snap, sources };
	if (degraded.length) {
		result.note = `Partial data: ${degraded.join('; ')} — null fields may be resolvable on retry.`;
	}
	return result;
}

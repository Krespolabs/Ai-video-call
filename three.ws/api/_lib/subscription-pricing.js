// Pure subscription pricing + period math. No I/O, no Solana, no DB — so it is
// cheap to unit-test and safe to import anywhere. The on-chain + DB logic lives
// in subscription-checkout.js, which re-exports these for its callers.

// Canonical mainnet USDC mint (6 decimals). Subscriptions price in USD; the
// on-chain leg settles in USDC at parity.
export const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;

/**
 * Convert a USD price (numeric, e.g. 9.99) to USDC atomic units (6 decimals).
 * Rounds to the nearest atomic so a price like 4.999 can't silently truncate.
 * @param {number|string} priceUsd
 * @returns {bigint}
 */
export function usdToUsdcAtomics(priceUsd) {
	const n = Number(priceUsd);
	if (!Number.isFinite(n) || n < 0) throw new Error('invalid price');
	return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

/**
 * Period length in ms for a plan interval. weekly → 7d, anything else → 30d
 * (matches subscription-billing.js + the creator_subscriptions cron).
 * @param {string} interval
 */
export function intervalMs(interval) {
	return interval === 'weekly' ? 7 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
}

/**
 * Compute the subscription period window from a start date + plan interval.
 * @param {string} interval
 * @param {Date} [from]
 * @returns {{ start: Date, end: Date }}
 */
export function computePeriod(interval, from = new Date()) {
	const start = new Date(from.getTime());
	const end = new Date(start.getTime() + intervalMs(interval));
	return { start, end };
}

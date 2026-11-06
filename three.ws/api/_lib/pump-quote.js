// Quote-currency resolution for pump.fun agent-token launches.
//
// Agent tokens earn USDC (x402 payments → buyback vault) and burn via the
// USDC-funded buyback. For that buyback to swap USDC → the agent's token, the
// coin's bonding curve must be USDC-paired (quote mint = USDC). This module is
// the single place that classifies a requested launch quote into SOL- vs
// USDC-paired so the launch handlers, persistence, and UI stay consistent.
//
// Pure + dependency-light so it is unit-testable without the chain.

import { SOLANA_USDC_MINT, SOLANA_USDC_MINT_DEVNET } from '../payments/_config.js';

// Wrapped SOL — the canonical quote mint for SOL-paired coins under the v2
// unified interface. On-chain SOL curves store `bonding_curve.quote_mint` as the
// system default pubkey (all-zeros); both mean "SOL-paired".
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SYSTEM_DEFAULT_PUBKEY = '11111111111111111111111111111111';

/** The USDC mint for a network ('mainnet' | 'devnet'). */
export function usdcMintFor(network) {
	return network === 'devnet' ? SOLANA_USDC_MINT_DEVNET : SOLANA_USDC_MINT;
}

/**
 * Classify a requested launch quote mint.
 *
 * @param {object} args
 * @param {string|null|undefined} args.quoteMint  Requested quote mint (base58),
 *   or null/omitted for SOL-paired.
 * @param {'mainnet'|'devnet'} [args.network='mainnet']
 * @returns {{ isUsdc: boolean, quoteMint: string|null, label: 'SOL'|'USDC'|'TOKEN' }}
 *   - `quoteMint`: canonical value to persist — `null` for SOL-paired (so the
 *     SDK/curve uses native SOL), or the explicit mint for a stable pair.
 *   - `isUsdc`: true for any non-SOL quote (stable-paired).
 *   - `label`: display label; 'USDC' when it matches the network USDC mint.
 */
export function classifyLaunchQuote({ quoteMint, network = 'mainnet' } = {}) {
	const q = typeof quoteMint === 'string' ? quoteMint.trim() : '';
	if (!q || q === WSOL_MINT || q === SYSTEM_DEFAULT_PUBKEY) {
		return { isUsdc: false, quoteMint: null, label: 'SOL' };
	}
	return { isUsdc: true, quoteMint: q, label: q === usdcMintFor(network) ? 'USDC' : 'TOKEN' };
}

/**
 * Concrete `quote_mint` + `quote_symbol` columns for a recorded trade row,
 * derived from the coin's stored pairing mint (`pump_agent_mints.quote_mint`,
 * where `null` means SOL-paired). Reuses {@link classifyLaunchQuote} so the
 * launch path and the trade path agree on what "USDC-paired" means.
 *
 * Unlike the launch column (which persists `null` for SOL so the curve uses
 * native SOL), trade rows persist a concrete mint — wrapped SOL for SOL-paired
 * — so every row is self-describing.
 *
 * @param {object} args
 * @param {string|null|undefined} args.quoteMint  The coin's pairing mint.
 * @param {'mainnet'|'devnet'} [args.network='mainnet']
 * @returns {{ quote_mint: string, quote_symbol: 'SOL'|'USDC'|'OTHER' }}
 */
export function tradeQuoteColumns({ quoteMint, network = 'mainnet' } = {}) {
	const c = classifyLaunchQuote({ quoteMint, network });
	if (!c.isUsdc) return { quote_mint: WSOL_MINT, quote_symbol: 'SOL' };
	return { quote_mint: c.quoteMint, quote_symbol: c.label === 'USDC' ? 'USDC' : 'OTHER' };
}

/**
 * Atomic units of the quote asset that moved to/from `wallet` in a confirmed,
 * parsed Solana transaction — the real amount a buy spent or a sell received,
 * read from on-chain pre/post balances instead of trusting client input. Used
 * by the confirm handlers when the client doesn't supply the quote amount
 * (e.g. sells, which only carry the token quantity).
 *
 *   SOL  → native lamports delta for the wallet account, with the tx fee added
 *          back when the wallet is the fee payer so a buy's spend excludes
 *          network fees and a sell's proceeds aren't undercounted.
 *   USDC → the wallet's quote-token (USDC) balance delta in 6-dec atomics.
 *
 * @param {object} args
 * @param {object} args.tx           Parsed tx from `getParsedTransaction`.
 * @param {string} args.wallet       Base58 owner whose delta we measure.
 * @param {'SOL'|'USDC'|'OTHER'} args.quoteSymbol
 * @param {string} args.quoteMint    The quote SPL mint (for the SPL branch).
 * @returns {string|null} Non-negative integer string of atomic units, or null
 *   when the delta can't be determined.
 */
export function walletQuoteDeltaAtomics({ tx, wallet, quoteSymbol, quoteMint }) {
	const meta = tx?.meta;
	const keys = tx?.transaction?.message?.accountKeys;
	if (!meta || !Array.isArray(keys) || !wallet) return null;

	if (quoteSymbol === 'SOL') {
		if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) return null;
		const idx = keys.findIndex((k) => (k?.pubkey ?? k)?.toString?.() === wallet);
		if (idx < 0) return null;
		const fee = idx === 0 ? Number(meta.fee || 0) : 0;
		const delta = Number(meta.postBalances[idx]) - Number(meta.preBalances[idx]) + fee;
		if (!Number.isFinite(delta) || delta === 0) return null;
		return String(Math.abs(Math.round(delta)));
	}

	const sumFor = (list) =>
		(Array.isArray(list) ? list : [])
			.filter((b) => b?.owner === wallet && b?.mint === quoteMint)
			.reduce((sum, b) => sum + BigInt(b?.uiTokenAmount?.amount || '0'), 0n);
	let delta;
	try {
		delta = sumFor(meta.postTokenBalances) - sumFor(meta.preTokenBalances);
	} catch {
		return null;
	}
	if (delta === 0n) return null;
	return (delta < 0n ? -delta : delta).toString();
}

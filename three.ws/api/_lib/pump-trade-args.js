// Pure argument helpers for pump.fun trade instruction building.
//
// Two SDK conventions these helpers exist to get right, verified against the
// vendored docs/IDLs in docs/pumpfun-program/ and the installed
// @pump-fun/pump-sdk@1.36.0 / @pump-fun/pump-swap-sdk@1.17.0 sources:
//
// 1. Slippage unit. Every @pump-fun builder takes slippage as a PERCENT
//    (`slippage: 1` = 1%): pump-sdk pads/floors via
//    `amount * floor(slippage * 10) / 1000`, pump-swap-sdk via
//    `1 ± slippage / 100`. Passing a fraction (bps / 10_000) silently
//    truncates the protection to ~0 on the curve and 100x too tight on the AMM.
//
// 2. Base token program. `create_v2` coins (every coin pump.fun mints today,
//    SOL- and USDC-paired alike) use Token-2022 base mints; legacy coins use
//    SPL Token. BUY.md/SELL.md require `base_token_program` to match the mint
//    owner, so it must be read from the mint account, never assumed.
//
// Pure + dependency-light so it is unit-testable without the chain.

import { PublicKey } from '@solana/web3.js';

import { SOLANA_USDC_MINT, SOLANA_USDC_MINT_DEVNET } from '../payments/_config.js';

export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Wrapped SOL — the canonical quote mint for SOL-paired v2 coins. On-chain SOL
// curves store `bonding_curve.quote_mint` as the system-default pubkey (all
// zeros); both that and the explicit WSOL mint mean "SOL-paired".
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SYSTEM_DEFAULT_PUBKEY = '11111111111111111111111111111111';

/** The USDC mint for a network ('mainnet' | 'devnet'). */
export function usdcMintForNetwork(network) {
	return network === 'devnet' ? SOLANA_USDC_MINT_DEVNET : SOLANA_USDC_MINT;
}

const KNOWN_TOKEN_PROGRAMS = new Set([
	SPL_TOKEN_PROGRAM_ID.toBase58(),
	TOKEN_2022_PROGRAM_ID.toBase58(),
]);

/**
 * Convert user-facing slippage basis points into the percent unit every
 * @pump-fun SDK builder expects. 100 bps -> 1 (percent).
 * Clamps to [0, 100] percent and returns the default (1%) for non-finite input.
 */
export function slippagePercentFromBps(bps, { defaultBps = 100 } = {}) {
	const n = Number(bps);
	const effective = Number.isFinite(n) ? n : defaultBps;
	return Math.max(0, Math.min(10_000, effective)) / 100;
}

/**
 * Resolve the token program for a mint from its account owner.
 * Throws a typed 422 for mints owned by anything other than SPL Token or
 * Token-2022 — building a trade against an unknown token program can only
 * fail on-chain, so fail fast here.
 *
 * @param {PublicKey|string} owner  The mint account's `owner` field.
 * @returns {PublicKey} SPL_TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID.
 */
export function resolveTokenProgramForMintOwner(owner) {
	const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
	if (!KNOWN_TOKEN_PROGRAMS.has(ownerPk.toBase58())) {
		const e = new Error(
			`mint owned by unknown token program ${ownerPk.toBase58()} — not an SPL/Token-2022 mint`,
		);
		e.status = 422;
		e.code = 'unsupported_token_program';
		throw e;
	}
	return ownerPk.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
}

/**
 * Resolve the quote asset for a custodial (server-signed) pump.fun trade from the
 * coin's on-chain bonding-curve quote mint. Mirrors the wallet-signed resolution
 * in api/pump/[action].js (handleBuyPrep / handleSellPrep) so the autonomous and
 * wallet paths always agree on which currency a coin trades in.
 *
 * A SOL-paired curve stores `quote_mint` as null/undefined (older fetches) or the
 * system-default pubkey (all zeros); the explicit WSOL mint means the same thing.
 * Anything else is a stable/SPL quote: USDC when it matches the network USDC mint,
 * otherwise OTHER.
 *
 * Pure — no chain access — so it is unit-testable in isolation.
 *
 * @param {import('@solana/web3.js').PublicKey|string|null|undefined} curveQuoteMint
 *   `bondingCurve.quoteMint` from the on-chain curve.
 * @param {'mainnet'|'devnet'} [network='mainnet']
 * @returns {{ isSol: boolean, isUsdc: boolean, quoteSymbol: 'SOL'|'USDC'|'OTHER', quoteMint: string }}
 *   - `isSol`: SOL-paired — trade in native SOL, no quote ATA needed.
 *   - `isUsdc`: USDC-paired — trade in USDC, requires the agent's USDC ATA.
 *   - `quoteMint`: canonical mint string to build/record against (WSOL for SOL).
 *   - `quoteSymbol`: stable display/record label.
 */
export function resolveCustodialQuote(curveQuoteMint, network = 'mainnet') {
	const raw =
		curveQuoteMint == null
			? ''
			: curveQuoteMint instanceof PublicKey
				? curveQuoteMint.toBase58()
				: String(curveQuoteMint).trim();

	if (!raw || raw === WSOL_MINT || raw === SYSTEM_DEFAULT_PUBKEY) {
		return { isSol: true, isUsdc: false, quoteSymbol: 'SOL', quoteMint: WSOL_MINT };
	}
	if (raw === usdcMintForNetwork(network)) {
		return { isSol: false, isUsdc: true, quoteSymbol: 'USDC', quoteMint: raw };
	}
	return { isSol: false, isUsdc: false, quoteSymbol: 'OTHER', quoteMint: raw };
}

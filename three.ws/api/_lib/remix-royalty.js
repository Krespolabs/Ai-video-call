// Remix royalties — provenance income for 3D-asset creators (PAID track only).
//
// When an agent remixes a published asset (generates a NEW model FROM another
// creator's GLB), the remix fee is paid in USDC over x402 and a creator-set
// slice of that fee routes back to the ORIGINAL creator. This is the asset-bazaar
// analogue of api/_lib/fork-royalties.js (which streams SOL up an avatar fork
// lineage): same fairness guardrails, different rail (USDC, settled via the x402
// facilitator + a real guarded transfer in api/x402/remix-asset.js).
//
// This module is the PURE math — no DB, no chain — so the split + caps are
// unit-tested in isolation (tests/remix-royalty.test.js). $THREE-policy clean:
// USDC is the settlement asset only; no other coin is named anywhere.

// ── Policy constants (the fairness guardrails) ───────────────────────────────

// The most a creator may set as their remix royalty (20%). A creator configuring
// a higher rate is clamped to this; the remixer always keeps the clear majority.
export const REMIX_ROYALTY_CAP_BPS = 2000;

// The default royalty applied when a remixable asset doesn't set its own rate.
export const REMIX_ROYALTY_DEFAULT_BPS = 1000;

// USDC has 6 decimals; a royalty below this (0.01 USDC) costs more in transfer
// fees than it moves, so it's recorded but not paid out — the dust floor.
export const REMIX_MIN_PAYOUT_ATOMICS = 10_000n;

// USDC atomic units per whole token (6 decimals). The bazaar prices in atomics.
export const USDC_DECIMALS = 6;

/** Clamp a creator-supplied royalty rate to [0, REMIX_ROYALTY_CAP_BPS]. */
export function clampRoyaltyBps(bps) {
	const n = Math.round(Number(bps));
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(n, REMIX_ROYALTY_CAP_BPS);
}

/** Coerce any price-ish input to a non-negative BigInt of USDC atomics. */
function toAtomics(value) {
	if (typeof value === 'bigint') return value < 0n ? 0n : value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value <= 0) return 0n;
		return BigInt(Math.floor(value));
	}
	const s = String(value ?? '').trim();
	if (!/^\d+$/.test(s)) return 0n;
	return BigInt(s);
}

/**
 * Compute the remix-fee split. Pure and exact: the creator royalty is
 * floor(price × bps / 10000), clamped to the policy cap and never below the dust
 * floor (a sub-dust royalty is dropped, not paid). The platform keeps the
 * remainder. The invariant creatorAtomics + platformAtomics === priceAtomics
 * holds for every input — no value is created or lost.
 *
 * @param {{ priceAtomics: bigint|number|string, royaltyBps?: number }} args
 * @returns {{
 *   priceAtomics: bigint,
 *   royaltyBps: number,        // the effective (clamped) rate actually applied
 *   requestedBps: number,      // the rate before clamping (for transparency)
 *   creatorAtomics: bigint,    // routed to the original creator
 *   platformAtomics: bigint,   // kept by the platform
 *   capped: boolean,           // true when the requested rate exceeded the cap
 *   dust: boolean,             // true when a non-zero royalty fell below the floor
 *   creatorUsd: number,        // human-readable convenience values
 *   platformUsd: number,
 * }}
 */
export function computeRemixSplit({ priceAtomics, royaltyBps }) {
	const price = toAtomics(priceAtomics);
	const requestedBps = Math.max(0, Math.round(Number(royaltyBps ?? REMIX_ROYALTY_DEFAULT_BPS) || 0));
	const effectiveBps = clampRoyaltyBps(requestedBps);
	const capped = requestedBps > REMIX_ROYALTY_CAP_BPS;

	let creator = price > 0n && effectiveBps > 0 ? (price * BigInt(effectiveBps)) / 10000n : 0n;
	let dust = false;
	if (creator > 0n && creator < REMIX_MIN_PAYOUT_ATOMICS) {
		// Below the dust floor — not worth an on-chain transfer; the platform keeps
		// it and the ledger records why. Honest: no fake "pending" we never pay.
		creator = 0n;
		dust = true;
	}
	const platform = price - creator;

	return {
		priceAtomics: price,
		royaltyBps: effectiveBps,
		requestedBps,
		creatorAtomics: creator,
		platformAtomics: platform,
		capped,
		dust,
		creatorUsd: atomicsToUsd(creator),
		platformUsd: atomicsToUsd(platform),
	};
}

/** USDC atomics (BigInt) → a USD float for display. Never used for settlement. */
export function atomicsToUsd(atomics) {
	const n = typeof atomics === 'bigint' ? atomics : toAtomics(atomics);
	return Number(n) / 10 ** USDC_DECIMALS;
}

/** USDC float → atomic units (BigInt, floored). Mirrors agent-usdc-transfer. */
export function usdcToAtomics(usdc) {
	return BigInt(Math.max(0, Math.floor(Number(usdc) * 10 ** USDC_DECIMALS)));
}

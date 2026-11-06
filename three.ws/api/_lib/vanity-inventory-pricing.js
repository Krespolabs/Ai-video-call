// Premium vanity inventory — the difficulty → price curve.
//
// The live grind tier is a flat ~$0.05 for ≤3 chars. Premium inventory sells
// 4–5+ char patterns that cost real batch CPU to find, so price scales with
// grind difficulty. We price on RARITY BITS (log2 of expected attempts, plus the
// dictionary/palindrome/bookend bonuses from src/solana/vanity/rarity.js) rather
// than raw attempts so a "real word" or palindrome automatically commands a
// premium the naive attempt count would miss.
//
// Curve: price = A·e^(B·bits), clamped to [MIN, MAX] = [$1, $50], then snapped to
// a clean price point. Anchored so:
//   • ~2-char / ~11 bits  → the $1 floor
//   • 4-char  / ~23 bits  → ~$13
//   • 5-char  / ~29 bits  → ~$45, i.e. near the $50 ceiling
// Each extra Base58 character is ~5.86 bits (58×) harder, so the curve roughly
// doubles the price every ~3.3 bits — tracking the exponential jump in grind cost
// while staying inside a sane retail band. Cloud spot CPU cost per address is a
// fraction of a cent even at 5 chars, so this is value-based pricing with a huge
// margin, not cost-plus — the point of grinding ahead on cheap credits.

import { computeRarity } from '../../src/solana/vanity/rarity.js';

export const MIN_PRICE_USD = 1;
export const MAX_PRICE_USD = 50;

// e^(B·bits) coefficients (see header for the anchor points they satisfy).
const A = 0.1014;
const B = 0.208;

/** Snap a raw price into a curated retail point (whole/half-dollar bands). */
function snapPrice(usd) {
	if (usd <= MIN_PRICE_USD) return MIN_PRICE_USD;
	if (usd >= MAX_PRICE_USD) return MAX_PRICE_USD;
	if (usd < 5) return Math.round(usd * 2) / 2; // nearest $0.50
	if (usd < 20) return Math.round(usd); // nearest $1
	return Math.round(usd / 5) * 5; // nearest $5
}

/**
 * Price a rarity breakdown (from computeRarity).
 * @param {{ rarityBits:number }} rarity
 * @returns {{ priceUsd:number, priceAtomics:number }}
 */
export function priceFromRarity(rarity) {
	const bits = Math.max(0, Number(rarity?.rarityBits) || 0);
	const raw = A * Math.exp(B * bits);
	const priceUsd = snapPrice(raw);
	return { priceUsd, priceAtomics: Math.round(priceUsd * 1_000_000) };
}

/**
 * Full pricing for a pattern: computes rarity, then price.
 * @param {{ prefix?:string, suffix?:string, ignoreCase?:boolean }} pattern
 * @returns {{ priceUsd:number, priceAtomics:number, rarity:object }}
 */
export function priceForPattern(pattern) {
	const rarity = computeRarity(pattern || {});
	const { priceUsd, priceAtomics } = priceFromRarity(rarity);
	return { priceUsd, priceAtomics, rarity };
}

// Rare-name rarity pricing for *.threews.sol.
//
// SCARCITY LEVER: common names mint FREE (growth — see the free-forever allowlist
// 'name.common'); rare names are priced in $THREE by their rarity. Rarity is a
// pure function of the label, so the price is deterministic, explainable, and the
// same on client and server. Proceeds settle through POLICY.SCARCITY (treasury +
// holder rewards) via charge-three — no burn.
//
// Rarity axes (highest wins):
//   • length      — shorter is rarer (1–4 chars are premium; 5–6 elevated)
//   • all-digits  — "0001"-style numeric handles are collectible
//   • dictionary  — a short, common English word reads as a brand
//   • repeating    — "aaaa", "777" patterns
// Everything else (7+ chars, mixed) is COMMON → free.

const RESERVED = new Set([
	'three', 'admin', 'root', 'support', 'help', 'team', 'official', 'www', 'api',
	'wallet', 'token', 'dao', 'mint', 'pump', 'sol', 'solana',
]);

// A tiny, high-signal dictionary of short brandable words. Not exhaustive — it
// only needs to catch the obviously-valuable ones; anything else prices on length.
const DICTIONARY = new Set([
	'fire', 'moon', 'gold', 'king', 'star', 'wolf', 'cash', 'coin', 'luck', 'zero',
	'neo', 'apex', 'volt', 'nova', 'rare', 'mint', 'base', 'edge', 'flux', 'halo',
	'cyber', 'pixel', 'ghost', 'titan', 'royal', 'magic', 'ninja', 'pulse',
]);

// Rarity tiers, rarest first. `usd` is the floor price for a name in this tier;
// auctions can clear above it. Tunable knobs (plan): starting points.
export const RARITY_TIERS = Object.freeze([
	{ id: 'legendary', label: 'Legendary', usd: 5000, blurb: '1–2 characters — the rarest handles' },
	{ id: 'epic', label: 'Epic', usd: 1000, blurb: '3 characters, reserved words, or repeating patterns' },
	{ id: 'rare', label: 'Rare', usd: 250, blurb: '4 characters or a short dictionary word' },
	{ id: 'uncommon', label: 'Uncommon', usd: 50, blurb: '5–6 characters or all-digit handles' },
	{ id: 'common', label: 'Common', usd: 0, blurb: '7+ characters — free to mint' },
]);

const TIER_BY_ID = Object.fromEntries(RARITY_TIERS.map((t) => [t.id, t]));

function normalizeLabel(name) {
	// Accept "foo" or "foo.threews.sol"; price only the leaf label, lowercased.
	const leaf = String(name || '')
		.trim()
		.toLowerCase()
		.replace(/\.threews\.sol$/, '')
		.replace(/\.sol$/, '');
	return leaf;
}

/** Is this a valid SNS leaf label (a-z0-9 hyphen, 1–63 chars, no leading/trailing hyphen)? */
export function isValidLabel(name) {
	const leaf = normalizeLabel(name);
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(leaf);
}

function isRepeating(s) {
	return s.length >= 3 && /^(.)\1+$/.test(s);
}

/**
 * Classify a name's rarity tier. Pure, deterministic.
 * @returns {{ tier: string, label: string, usd: number, blurb: string, free: boolean, reasons: string[] }}
 */
export function rarityFor(name) {
	const leaf = normalizeLabel(name);
	const reasons = [];
	let tierId = 'common';

	const len = leaf.length;
	const allDigits = /^[0-9]+$/.test(leaf);

	if (len > 0 && len <= 2) {
		tierId = 'legendary';
		reasons.push(`${len}-character handle`);
	} else if (len === 3 || RESERVED.has(leaf) || isRepeating(leaf)) {
		tierId = 'epic';
		if (len === 3) reasons.push('3-character handle');
		if (RESERVED.has(leaf)) reasons.push('reserved word');
		if (isRepeating(leaf)) reasons.push('repeating pattern');
	} else if (len === 4 || DICTIONARY.has(leaf)) {
		tierId = 'rare';
		if (len === 4) reasons.push('4-character handle');
		if (DICTIONARY.has(leaf)) reasons.push('dictionary word');
	} else if (len <= 6 || allDigits) {
		tierId = 'uncommon';
		if (len <= 6) reasons.push(`${len}-character handle`);
		if (allDigits) reasons.push('all-digit handle');
	} else {
		reasons.push('standard handle');
	}

	const t = TIER_BY_ID[tierId];
	return { tier: t.id, label: t.label, usd: t.usd, blurb: t.blurb, free: t.usd === 0, reasons };
}

/**
 * Price a name for the scarcity rail. Returns the floor USD and whether it's free.
 * Variable per-call price = the rarity floor; an auction layer may set a higher
 * clearing price, which callers pass straight to charge-three as `usd`.
 */
export function priceName(name) {
	if (!isValidLabel(name)) {
		const e = new Error('invalid name label');
		e.status = 400;
		e.code = 'invalid_label';
		throw e;
	}
	const r = rarityFor(name);
	return {
		label: normalizeLabel(name),
		rarity: r.tier,
		rarity_label: r.label,
		reasons: r.reasons,
		free: r.free,
		usd: r.usd,
		// The catalog action a paid name charges through; common names skip the rail.
		action: r.free ? null : 'name.auction',
	};
}

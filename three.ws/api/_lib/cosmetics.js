// Cosmetics catalog — the single source of truth for the avatar shop (R21) and
// the x402 purchase flow (R22) / owned-inventory (R23) that build on it.
//
// Each entry is both a SHOP item (id, name, slot, rarity, price, previewImage)
// and the RIG payload the live-preview needs (kind + glbUrl/attachBone for
// bone-attached accessories, morphBinding for outfits, colors for skins, emote
// for premium animations). Wearable accessory ids mirror
// public/accessories/presets.json so the R03 rig attaches them identically.
//
// Pricing is denominated in $THREE (CA FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump),
// the only coin this platform references. R22 charges these amounts over x402.
//
// Ownership model (until R23 wires wallet-bound inventory): the base accessory
// pack ships with every avatar and is OWNED; premium emotes + skins are LOCKED
// until purchased. `premium: false` ⇒ owned, `premium: true` ⇒ locked.

export const RARITIES = ['common', 'rare', 'epic', 'legendary'];

// $THREE price by rarity. Premium items charge; owned base items are free (0).
const PRICE_BY_RARITY = { common: 25, rare: 100, epic: 300, legendary: 750 };

// USDC settlement price by rarity, in atomics (6 decimals). $THREE is the coin
// the shop *quotes* (PRICE_BY_RARITY, coin-facing copy); USDC is the asset the
// x402 rail actually *settles* (R22). The two are deliberately separate: the
// catalog shows an item's $THREE value, checkout charges this USDC amount over
// x402. Tunable per rarity at deploy time via X402_PRICE_COSMETIC_<RARITY>.
const USDC_ATOMICS_BY_RARITY = {
	common: '250000',     // $0.25
	rare: '500000',       // $0.50
	epic: '1500000',      // $1.50
	legendary: '3000000', // $3.00
};

// The USDC charge (atomics, 6 decimals) for an item's x402 purchase. Owned base
// items are free ('0'). Reads an env override first so ops can retune unit
// economics without a code change; falls back to the rarity default. The server
// is the sole source of this number — the client never supplies a price.
export function priceUsdcAtomicsOf(item) {
	if (!item?.premium) return '0';
	const key = `X402_PRICE_COSMETIC_${String(item.rarity || '').toUpperCase()}`;
	const raw = process.env[key];
	if (raw != null && /^\d+$/.test(String(raw).trim())) return String(raw).trim();
	return USDC_ATOMICS_BY_RARITY[item.rarity] ?? USDC_ATOMICS_BY_RARITY.rare;
}

// Human-readable USDC price (whole dollars, 2dp) for shop copy — e.g. '0.50'.
export function priceUsdcDisplayOf(item) {
	return (Number(priceUsdcAtomicsOf(item)) / 1e6).toFixed(2);
}

// Slots double as the R03 per-slot attachment category and the shop filter axis.
export const SLOTS = ['hat', 'glasses', 'earrings', 'outfit', 'skin', 'emote'];

// The catalog. Order here is the shop's default display order.
const CATALOG = [
	// ── Base accessory pack (owned, free) — bone-attached GLBs ────────────────
	{ id: 'hat-baseball', name: 'Baseball Cap', slot: 'hat', kind: 'hat', rarity: 'common',
		glbUrl: '/accessories/hat-baseball.glb', attachBone: 'Head', previewImage: '/accessories/thumbs/hat-baseball.png' },
	{ id: 'hat-beanie', name: 'Beanie', slot: 'hat', kind: 'hat', rarity: 'common',
		glbUrl: '/accessories/hat-beanie.glb', attachBone: 'Head', previewImage: '/accessories/thumbs/hat-beanie.png' },
	{ id: 'hat-cowboy', name: 'Cowboy Hat', slot: 'hat', kind: 'hat', rarity: 'rare',
		glbUrl: '/accessories/hat-cowboy.glb', attachBone: 'Head', previewImage: '/accessories/thumbs/hat-cowboy.png' },
	{ id: 'glasses-round', name: 'Round Glasses', slot: 'glasses', kind: 'glasses', rarity: 'common',
		glbUrl: '/accessories/glasses-round.glb', attachBone: 'Head', anchor: 'face', previewImage: '/accessories/thumbs/glasses-round.png' },
	{ id: 'glasses-shades', name: 'Shades', slot: 'glasses', kind: 'glasses', rarity: 'rare',
		glbUrl: '/accessories/glasses-shades.glb', attachBone: 'Head', anchor: 'face', previewImage: '/accessories/thumbs/glasses-shades.png' },
	{ id: 'earrings-hoops', name: 'Hoop Earrings', slot: 'earrings', kind: 'earrings', rarity: 'common',
		glbUrl: '/accessories/earrings-hoops.glb', attachBone: 'Head', previewImage: '/accessories/thumbs/earrings-hoops.png' },
	{ id: 'earrings-studs', name: 'Stud Earrings', slot: 'earrings', kind: 'earrings', rarity: 'common',
		glbUrl: '/accessories/earrings-studs.glb', attachBone: 'Head', previewImage: '/accessories/thumbs/earrings-studs.png' },

	// ── Outfit morphs (owned, free) — drive the avatar's own morph targets ────
	{ id: 'outfit-casual', name: 'Casual Fit', slot: 'outfit', kind: 'outfit', rarity: 'common',
		morphBinding: { Outfit_Casual: 1.0 }, previewImage: null },
	{ id: 'outfit-sporty', name: 'Sporty Fit', slot: 'outfit', kind: 'outfit', rarity: 'common',
		morphBinding: { Outfit_Sporty: 1.0 }, previewImage: null },
	{ id: 'outfit-formal', name: 'Formal Fit', slot: 'outfit', kind: 'outfit', rarity: 'rare',
		morphBinding: { Outfit_Formal: 1.0 }, previewImage: null },

	// ── Premium skins (locked) — recolour the avatar's garment layers ─────────
	{ id: 'skin-crimson', name: 'Crimson Threads', slot: 'skin', kind: 'skin', rarity: 'rare', premium: true,
		colors: { outfit: '#7a1d1d' }, previewImage: null },
	{ id: 'skin-whiteout', name: 'Whiteout', slot: 'skin', kind: 'skin', rarity: 'epic', premium: true,
		colors: { outfit: '#f1f1f4' }, previewImage: null },
	{ id: 'skin-midnight', name: 'Midnight', slot: 'skin', kind: 'skin', rarity: 'legendary', premium: true,
		colors: { outfit: '#0c0c14', hair: '#101018' }, previewImage: null },
	{ id: 'skin-gold', name: 'Liquid Gold', slot: 'skin', kind: 'skin', rarity: 'legendary', premium: true,
		colors: { outfit: '#caa64a', hair: '#8a6f2a' }, previewImage: null },

	// ── Premium emotes (locked) — one-shot animation clips (manifest names) ────
	{ id: 'emote-headbang', name: 'Headbang', slot: 'emote', kind: 'emote', rarity: 'rare', premium: true,
		emote: 'av-headbang', previewImage: null },
	{ id: 'emote-shuffle', name: 'Shuffle', slot: 'emote', kind: 'emote', rarity: 'rare', premium: true,
		emote: 'av-dance-shuffle', previewImage: null },
	{ id: 'emote-rumba', name: 'Rumba', slot: 'emote', kind: 'emote', rarity: 'epic', premium: true,
		emote: 'rumba', previewImage: null },
	{ id: 'emote-capoeira', name: 'Capoeira', slot: 'emote', kind: 'emote', rarity: 'epic', premium: true,
		emote: 'capoeira', previewImage: null },
	{ id: 'emote-thriller', name: 'Thriller', slot: 'emote', kind: 'emote', rarity: 'legendary', premium: true,
		emote: 'thriller', previewImage: null },
];

const BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

export function getCosmetic(id) {
	return BY_ID.get(id) || null;
}

export function isValidCosmeticId(id) {
	return BY_ID.has(id);
}

// The $THREE price of an item (premium items only; owned base items are free).
export function priceOf(item) {
	if (!item?.premium) return 0;
	return PRICE_BY_RARITY[item.rarity] ?? PRICE_BY_RARITY.common;
}

// Build the catalog as the API/client consume it. `ownedIds` is the set of
// extra ids the caller owns (purchased — wired in R23); base non-premium items
// are always owned. `rarity` optionally filters to one rarity tier.
export function buildCatalog({ ownedIds = [], rarity = null } = {}) {
	const owned = new Set(ownedIds);
	return CATALOG
		.filter((c) => !rarity || c.rarity === rarity)
		.map((c) => {
			const isOwned = !c.premium || owned.has(c.id);
			const price = priceOf(c);
			return {
				id: c.id,
				name: c.name,
				slot: c.slot,
				kind: c.kind,
				rarity: c.rarity,
				price,
				// $THREE is the only coin — the item's quoted value is in it.
				currency: 'THREE',
				// What the x402 rail actually charges at checkout: USDC (R22). Atomics
				// (6dp) for the protocol + a display string for the buy button.
				priceUsdcAtomics: priceUsdcAtomicsOf(c),
				priceUsdc: priceUsdcDisplayOf(c),
				premium: !!c.premium,
				owned: isOwned,
				locked: !isOwned,
				previewImage: c.previewImage || null,
				// Rig payload the live preview needs — only the relevant keys per kind.
				...(c.glbUrl ? { glbUrl: c.glbUrl, attachBone: c.attachBone, ...(c.anchor ? { anchor: c.anchor } : {}) } : {}),
				...(c.morphBinding ? { morphBinding: c.morphBinding } : {}),
				...(c.colors ? { colors: c.colors } : {}),
				...(c.emote ? { emote: c.emote } : {}),
			};
		});
}

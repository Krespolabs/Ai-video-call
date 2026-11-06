// Commerce price tables (W04) — the single source of truth for the /play general
// store (cash sell/buy) and the $THREE boutique (premium cosmetic unlocks). Shared
// verbatim by the authoritative server (WalkRoom validates every transaction against
// these) and the client (PlayCommerce renders the catalogs from the same numbers),
// so a price the player sees is exactly the price the server charges — no drift.
// Dependency-free beyond the item/cosmetic registries so both the Node server and the
// Vite client import the identical table.
//
// Two currencies, kept strictly separate:
//   • CASH — the in-game purse ("gold"): a game resource earned by gathering, fishing
//     and combat and spent at the general store. Never on-chain, never a token.
//   • $THREE — the platform's only coin (CA in CLAUDE.md). Spent on-chain at the
//     boutique to unlock premium cosmetics. The on-chain settlement + verification
//     live in game-token.js; this module only holds the catalog the boutique reads.

import { itemLabel } from './items.js';
import { COSMETICS, getCosmetic } from './cosmetics-catalog.js';

// --- General store: cash economy -------------------------------------------

// Cash a vendor pays for one unit of a gathered/looted item. ONLY items listed here
// are sellable — tools, weapons, ammo, the armor vest, mounts and the rest of the
// starter kit are deliberately excluded so a player can neither dump their kit for
// cash nor farm a buy→sell arbitrage. Values are tuned so honest gathering funds a
// few catalog upgrades without trivialising progression.
export const SELL_PRICES = {
	wood: 2,
	stone: 2,
	coal: 6,
	fish: 3,
	cookedFish: 9,
	bones: 4,
	hide: 8,
};

// The general store's buy catalog: tools and consumables a player can replace or
// stock up on with cash. Each entry buys `qty` of `item` for `price` cash. Every item
// here has a real in-game use today (gather/fish tools, a melee weapon, heal potions,
// the armor vest, and the ammo the W07 weapons burn) — nothing dead is sold.
export const BUY_CATALOG = [
	{ item: 'rod', qty: 1, price: 45 },
	{ item: 'axe', qty: 1, price: 40 },
	{ item: 'pickaxe', qty: 1, price: 50 },
	{ item: 'hammer', qty: 1, price: 40 },
	{ item: 'sword', qty: 1, price: 120 },
	{ item: 'healthPotion', qty: 1, price: 30 },
	{ item: 'vest', qty: 1, price: 60 },
	{ item: 'ammo', qty: 12, price: 24 },
	{ item: 'arrow', qty: 12, price: 18 },
];

const BUY_BY_ITEM = new Map(BUY_CATALOG.map((e) => [e.item, e]));

// Cash one unit of `item` sells for (0 = the store won't buy it).
export function sellPrice(item) {
	return SELL_PRICES[item] || 0;
}

export function isSellable(item) {
	return sellPrice(item) > 0;
}

// The catalog entry for a buyable item, or null when it isn't for sale.
export function buyEntry(item) {
	return BUY_BY_ITEM.get(item) || null;
}

// Serializable catalog for the client store UI — labels resolved here so the client
// renders names from the same vocabulary the server uses.
export function clientStoreCatalog() {
	return {
		sell: Object.entries(SELL_PRICES).map(([item, price]) => ({ item, label: itemLabel(item), price })),
		buy: BUY_CATALOG.map((e) => ({ item: e.item, qty: e.qty, price: e.price, label: itemLabel(e.item) })),
	};
}

// --- $THREE boutique: premium cosmetic unlocks -----------------------------
//
// The boutique sells the premium cosmetics from cosmetics-catalog.js. Each cosmetic's
// `price` is its cost in WHOLE $THREE tokens; the boutique charges exactly that
// on-chain (built, settled and verified in game-token.js) and, on success, grants the
// unlock into the account's owned set — the W04 unlock ledger that W03's wardrobe
// reads. Only premium cosmetics appear here; free ones are already owned by everyone.

export function boutiqueListings() {
	return COSMETICS
		.filter((c) => c.tier === 'premium' && Number(c.price) > 0)
		.map((c) => ({
			id: c.id,
			name: c.name,
			slot: c.slot,
			rarity: c.rarity,
			price: Number(c.price),
			swatch: c.swatch || null,
			thumb: c.thumb || null,
		}));
}

// The $THREE price (whole tokens) to unlock `id`, or 0 when it isn't a sellable
// premium cosmetic. The server prices the on-chain charge from THIS, never from a
// client-supplied number.
export function boutiquePrice(id) {
	const c = getCosmetic(id);
	return c && c.tier === 'premium' && Number(c.price) > 0 ? Number(c.price) : 0;
}

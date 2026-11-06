// Item registry — the single source of truth for what items exist in the
// Kintara realms and how they behave. Rooms read THIS instead of branching on
// item ids inline, so stacking, edibility, heal values, and mount tuning are
// data-driven and an item means the same thing everywhere it appears.
//
// Reused by the /play coin-world economy (gather/cook/consume/banking) and, going
// forward, by the marketplace and the shop — they all describe items in the
// same vocabulary so a "cookedFish" is identical whether it was cooked, looted,
// or bought.
//
// Each entry:
//   stackable — stacks up to MAX_STACK in one slot (resources, food, potions).
//   tool      — equippable gather/combat tool; occupies the active slot, never
//               stacks (qty stays 1).
//   edible    — can be eaten via the `consume` intent to restore HP.
//   heal      — base HP restored when eaten (edible items only).
//   mount     — rideable steed tuning { stepMs, color, accent, scale }. stepMs
//               is the SERVER-enforced floor (ms between steps) while riding it;
//               lower is faster. The client derives its send cadence from this
//               so it can never out-pace what the server will accept.
//   icon      — emoji shown in the hotbar / tooltips (client convenience).
//   label     — human-facing name for toasts and tooltips.

export const ITEMS = {
	// Tools — non-stackable, one per slot.
	axe: { tool: true, stackable: false, icon: '🪓', label: 'Axe' },
	pickaxe: { tool: true, stackable: false, icon: '⛏️', label: 'Pickaxe' },
	rod: { tool: true, stackable: false, icon: '🎣', label: 'Fishing rod' },
	hammer: { tool: true, stackable: false, icon: '🔨', label: 'Hammer' },

	// Weapons — non-stackable tools that occupy the active slot. Their combat
	// tuning (damage, range, rate, ammo) lives in WEAPONS below; this entry is just
	// the inventory presence so they equip like any other tool. (W07)
	sword: { tool: true, weapon: true, stackable: false, icon: '⚔️', label: 'Sword' },
	bat: { tool: true, weapon: true, stackable: false, icon: '🏏', label: 'Bat' },
	pistol: { tool: true, weapon: true, stackable: false, icon: '🔫', label: 'Pistol' },
	bow: { tool: true, weapon: true, stackable: false, icon: '🏹', label: 'Bow' },

	// Ammunition — stackable consumables a ranged weapon burns one of per shot
	// (W04 consumable; spent server-side on a validated fire). (W07)
	ammo: { stackable: true, ammo: true, icon: '🔸', label: 'Ammo' },
	arrow: { stackable: true, ammo: true, icon: '🔹', label: 'Arrows' },

	// Body armor — a stackable consumable that, when worn, refills the armor layer
	// that absorbs damage before HP. Worn via the `consume` intent like a potion,
	// but tops up armor instead of health. (W07)
	vest: { stackable: true, armorValue: 50, icon: '🦺', label: 'Body armor' },

	// Gathered resources — stackable.
	wood: { stackable: true, icon: '🪵', label: 'Wood' },
	stone: { stackable: true, icon: '🪨', label: 'Stone' },
	coal: { stackable: true, icon: '⚫', label: 'Coal' },
	fish: { stackable: true, icon: '🐟', label: 'Raw fish' },

	// Monster drops — stackable trophy/material items from kills.
	bones: { stackable: true, icon: '🦴', label: 'Bones' },
	hide: { stackable: true, icon: '🟫', label: 'Beast hide' },

	// Cooked food — stackable and edible. Cooking raw fish at a Roast Pit yields
	// this; eating it restores HP.
	cookedFish: { stackable: true, edible: true, heal: 11, icon: '🍖', label: 'Cooked fish' },

	// Potions — stackable, edible, stronger heals. Introduced by the shop/loot;
	// defined here so the `consume` handler treats them correctly the moment they
	// enter a player's pack.
	healthPotion: { stackable: true, edible: true, heal: 28, icon: '🧪', label: 'Health potion' },

	// Mounts — rare drops you can ride for faster travel. Non-stackable; one per
	// slot. stepMs is the server-enforced step floor while riding (lower = faster
	// than the on-foot floor). The dire wolf is quick and light; the war boar is
	// a touch slower but a bigger, sturdier-looking steed.
	dire_wolf: {
		mount: { stepMs: 92, color: 0x6b7280, accent: 0xb9c2d0, scale: 1.0 },
		stackable: false, icon: '🐺', label: 'Dire Wolf',
	},
	war_boar: {
		mount: { stepMs: 104, color: 0x7a5230, accent: 0xd8b48a, scale: 1.15 },
		stackable: false, icon: '🐗', label: 'War Boar',
	},
};

// The set of item ids that stack — derived once from the registry so callers
// never hand-maintain a parallel list.
export const STACKABLE_ITEMS = new Set(
	Object.entries(ITEMS).filter(([, def]) => def.stackable).map(([id]) => id),
);

export function itemDef(item) {
	return ITEMS[item] || null;
}

export function isStackable(item) {
	return !!ITEMS[item]?.stackable;
}

export function isEdible(item) {
	return !!ITEMS[item]?.edible;
}

// Base HP restored when an edible item is eaten (0 for anything inedible).
export function healValue(item) {
	return ITEMS[item]?.heal || 0;
}

// Cooking-level-scaled HP restored for food. Cooked fish gives +0.3 HP per
// cooking level above 1 so a trained cook eats better; potions have a fixed
// potency that doesn't depend on who consumes them.
export function scaledHeal(item, cookingLevel) {
	const base = ITEMS[item]?.heal || 0;
	if (!base) return 0;
	if (item === 'cookedFish') {
		const lvl = Math.max(1, cookingLevel | 0);
		return base + Math.floor((lvl - 1) * 0.3);
	}
	return base;
}

export function itemLabel(item) {
	return ITEMS[item]?.label || item;
}

export function isEquippableWeapon(item) {
	return !!ITEMS[item]?.weapon;
}

export function isAmmo(item) {
	return !!ITEMS[item]?.ammo;
}

// Armor points a wearable item restores when worn (0 for non-armor items).
export function armorValue(item) {
	return ITEMS[item]?.armorValue || 0;
}

// ---------------------------------------------------------------------------
// Combat — weapons (W07)
// ---------------------------------------------------------------------------
//
// The authoritative weapon tuning table. The WalkRoom reads THIS to validate an
// attack intent (right tool equipped? target in range/arc? off cooldown? ammo?)
// and to roll damage — so balance lives in one data-driven place, never inline in
// the handler. Each entry:
//   kind        — 'melee' (range + frontal arc) or 'ranged' (hitscan line + ammo).
//   dmg         — base damage per hit, before the small combat-level scaling and
//                 the ±15% variance the room rolls.
//   range       — max metres from attacker to a valid target.
//   arc         — melee only: full frontal cone (radians) a target must sit within.
//   aimTol      — ranged only: angular tolerance (radians) between aim (yaw) and
//                 the bearing to a target — a light aim-assist on the hitscan.
//   cooldownMs  — server-enforced floor between swings/shots with this weapon.
//   ammo        — ranged only: the item id consumed one-per-shot.
export const WEAPONS = {
	sword: { kind: 'melee', dmg: 18, range: 2.7, arc: 1.5, cooldownMs: 620 },
	bat: { kind: 'melee', dmg: 12, range: 2.5, arc: 1.7, cooldownMs: 460 },
	pistol: { kind: 'ranged', dmg: 20, range: 34, aimTol: 0.22, cooldownMs: 430, ammo: 'ammo' },
	bow: { kind: 'ranged', dmg: 28, range: 42, aimTol: 0.16, cooldownMs: 880, ammo: 'arrow' },
};

export function weaponDef(item) {
	return WEAPONS[item] || null;
}

// ---------------------------------------------------------------------------
// Combat — mobs (W07/W08)
// ---------------------------------------------------------------------------
//
// PvE enemy tuning. Mobs spawn in danger zones, chase the nearest player, and
// fight through the SAME authoritative damage path players do. `kind` keys both
// this table and the LOOT_TABLES below, so a kill's rewards and its stats stay in
// lockstep. Each entry:
//   hp/dmg      — pool it spawns with / damage per landed swing (0 = harmless).
//   speed       — chase speed in m/s.
//   aggro       — metres at which it notices and pursues a player.
//   atkRange    — metres at which it can land a hit; atkCd — ms between its swings.
//   xp/gold     — combat XP and cash awarded to the killer.
//   scale/color — render hints for the client mesh.
//   hostile     — false for non-aggressive targets that never chase.
export const MOB_STATS = {
	dummy: { hp: 60, dmg: 0, speed: 0, aggro: 0, atkRange: 0, atkCd: 0, xp: 8, gold: 0, scale: 1.0, color: 0x9aa3b2, hostile: false },
	goblin: { hp: 42, dmg: 6, speed: 2.7, aggro: 15, atkRange: 1.9, atkCd: 1150, xp: 26, gold: 4, scale: 0.9, color: 0x5f8a3a, hostile: true },
	ogre: { hp: 95, dmg: 14, speed: 2.0, aggro: 17, atkRange: 2.5, atkCd: 1650, xp: 62, gold: 12, scale: 1.35, color: 0x8a6a3a, hostile: true },
	troll: { hp: 165, dmg: 22, speed: 1.8, aggro: 19, atkRange: 2.9, atkCd: 2000, xp: 128, gold: 28, scale: 1.7, color: 0x4a6a6a, hostile: true },
};

export function mobStats(kind) {
	return MOB_STATS[kind] || null;
}

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------

export function isMount(item) {
	return !!ITEMS[item]?.mount;
}

// The server-enforced minimum ms between steps while riding `item` (null if the
// item isn't a mount). Lower than the on-foot floor → visibly faster travel.
export function mountStepMs(item) {
	return ITEMS[item]?.mount?.stepMs ?? null;
}

// ---------------------------------------------------------------------------
// Loot tables
// ---------------------------------------------------------------------------

// Drop tables keyed by mob `kind`. Each entry is one INDEPENDENT roll:
//   { item, chance, min?, max? }  (min/max default to 1; stackables roll a qty)
// Training dummies intentionally drop nothing. Rolls are independent, so a kill
// can yield several lines or none — and a lucky kill can drop a rare mount.
export const LOOT_TABLES = {
	dummy: [],
	goblin: [
		{ item: 'bones', chance: 0.55, min: 1, max: 2 },
		{ item: 'hide', chance: 0.30 },
		{ item: 'coal', chance: 0.18 },
		{ item: 'dire_wolf', chance: 0.05 },
	],
	ogre: [
		{ item: 'bones', chance: 0.75, min: 1, max: 3 },
		{ item: 'hide', chance: 0.55, min: 1, max: 2 },
		{ item: 'stone', chance: 0.40, min: 1, max: 3 },
		{ item: 'dire_wolf', chance: 0.07 },
		{ item: 'war_boar', chance: 0.10 },
	],
	// Cave troll (Task 22): the combat-gated cavern's apex foe. Richer than an ogre
	// across the board — more bones/hide, reliable coal + stone from the seam it
	// guards, and the best mount odds in the world, so clearing the gate pays off.
	troll: [
		{ item: 'bones', chance: 0.90, min: 2, max: 4 },
		{ item: 'hide', chance: 0.70, min: 1, max: 3 },
		{ item: 'coal', chance: 0.55, min: 1, max: 3 },
		{ item: 'stone', chance: 0.45, min: 1, max: 3 },
		{ item: 'dire_wolf', chance: 0.12 },
		{ item: 'war_boar', chance: 0.15 },
	],
};

// Roll a mob's loot table into a flat list of { item, qty }. Pure given `rng`
// (defaults to Math.random) so it stays unit-testable and deterministic under a
// seeded rng.
export function rollLoot(kind, rng = Math.random) {
	const table = LOOT_TABLES[kind];
	if (!table) return [];
	const out = [];
	for (const entry of table) {
		if (rng() >= entry.chance) continue;
		const min = entry.min ?? 1;
		const max = entry.max ?? min;
		const qty = min + Math.floor(rng() * (max - min + 1));
		out.push({ item: entry.item, qty });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Gathering (woodcutting & mining) — W06
// ---------------------------------------------------------------------------

// Chance a single chop/strike yields a resource: 45% at level 1 on a difficulty-1
// node, rising +0.6%/level and divided by the node's difficulty (hardwood/dense rock
// gives up its goods less often). Clamped 5%–97%. Pure, mirroring fishCatchChance.
export function gatherChance(level, difficulty = 1) {
	const lvl = Math.max(1, level | 0);
	const d = difficulty > 0 ? difficulty : 1;
	const c = (0.45 + 0.006 * (lvl - 1)) / d;
	return Math.max(0.05, Math.min(0.97, c));
}

// Chance a successful gather yields two resources instead of one. Zero at level 1,
// growing with level and easing on tougher nodes, clamped at 40%. Mirrors
// fishDoubleChance.
export function gatherDoubleChance(level, difficulty = 1) {
	const lvl = Math.max(1, level | 0);
	const d = difficulty > 0 ? difficulty : 1;
	return Math.max(0, Math.min(0.4, (0.018 * (lvl - 1)) / d));
}

// Chance a successful mine ALSO surfaces a lump of coal alongside the stone, scaled
// by the seam's coal weight and the miner's level. Capped at 55% on the richest seam.
export function coalBonusChance(level, coalWeight = 1) {
	const lvl = Math.max(1, level | 0);
	const w = coalWeight > 0 ? coalWeight : 1;
	const c = (0.10 + 0.004 * (lvl - 1)) * w;
	return Math.max(0, Math.min(0.55, c));
}

// ---------------------------------------------------------------------------
// Client view
// ---------------------------------------------------------------------------

// The slim, serializable slice the client needs to label/render items (hotbar
// icons, loot toasts, mount meshes). Keeps the wire payload small — no loot
// tables or heal logic, since the client never rolls or resolves those.
// ---------------------------------------------------------------------------
// Cooking
// ---------------------------------------------------------------------------

// Burn chance when cooking raw fish: 40% at level 1, falling linearly to 0% by
// the high 30s, so a low-level cook loses some fish while a trained one never
// does. Clamped both ways. Pure and deterministic (the per-fish RNG roll lives
// in the cook handler) so the odds stay honest and unit-testable.
export function cookBurnChance(level) {
	const c = 0.4 - (Math.max(1, level) - 1) * 0.011;
	return Math.max(0, Math.min(0.4, c));
}

// ---------------------------------------------------------------------------
// Fishing
// ---------------------------------------------------------------------------

// Catch chance for a single cast: 40% at level 1 on average (quality 1) water,
// rising +0.5% per fishing level and scaled by the spot's quality multiplier
// (richer water both catches more often and yields doubles more often). Capped at
// 95% so even the best angler on the best water is never guaranteed a fish.
// Pure and deterministic (the cast handler rolls the RNG) so the odds are honest
// and unit-testable, mirroring cookBurnChance.
export function fishCatchChance(level, quality = 1) {
	const lvl = Math.max(1, level | 0);
	const q = quality > 0 ? quality : 1;
	const c = (0.4 + 0.005 * (lvl - 1)) * q;
	return Math.max(0, Math.min(0.95, c));
}

// Chance that a successful cast hauls in two fish instead of one. Zero at level 1,
// growing with level and spot quality, clamped at 45% so a double is always a
// treat rather than the norm.
export function fishDoubleChance(level, quality = 1) {
	const lvl = Math.max(1, level | 0);
	const q = quality > 0 ? quality : 1;
	return Math.max(0, Math.min(0.45, 0.02 * (lvl - 1) * q));
}

export function clientItemRegistry() {
	const out = {};
	for (const [id, it] of Object.entries(ITEMS)) {
		out[id] = {
			label: it.label || id,
			icon: it.icon || '📦',
			kind: it.mount ? 'mount' : it.weapon ? 'weapon' : it.tool ? 'tool' : it.armorValue ? 'armor' : it.ammo ? 'ammo' : it.edible ? 'food' : 'resource',
			stackable: !!it.stackable,
		};
		if (it.edible) out[id].heal = it.heal || 0;
		if (it.armorValue) out[id].armorValue = it.armorValue;
		if (it.weapon && WEAPONS[id]) out[id].weapon = { ...WEAPONS[id] };
		if (it.mount) out[id].mount = { ...it.mount };
	}
	return out;
}

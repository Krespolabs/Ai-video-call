// World zones & spawn-point registry for the /play open-world district.
//
// W01 lays the ground every other world feature stands on, and this module is
// the DATA spine of it: the named zones (downtown, docks, wilds…) other briefs
// flag for safe/danger PvP, NPC traffic, and quests, plus the spawn-point table
// they consume (where players drop in, where vehicles and vendors live, where a
// race grid lines up). It is pure data + cheap geometry helpers — no Three.js,
// no DOM — so the server, the client renderer, and any later system can all
// reason about the same map without drifting apart.
//
// Coordinates are world metres in the XZ plane; the ground sits at y = 0. The
// district is a square centred on the origin; the original circular plaza lives
// on as `Downtown`, the central spawn hub, so the totem/market screens/ponds the
// other systems anchor there keep working unchanged.

// District dimensions. The server mirrors `half` as WORLD_HALF_M in
// multiplayer/src/rooms/WalkRoom.js — keep the two in sync (the authoritative
// bounds clamp and the rendered world must agree).
export const DISTRICT = {
	half: 200,        // half-extent: the world spans [-200, 200] on X and Z (400 m square)
	plazaRadius: 58,  // central Downtown plaza — the spawn hub, kept clear of buildings
	blockSize: 46,    // city-block footprint (sidewalk slab edge)
	roadWidth: 12,    // street width between blocks
};

// Movement clamp limit. A small margin inside the hard edge so an avatar pressed
// against the bound never visually clips the world's rim. The server applies the
// same square clamp authoritatively (anti-teleport stays independent).
export const WORLD_BOUND = DISTRICT.half - 2;

// --- Zones -----------------------------------------------------------------
// Each zone carries a `kind` (drives the HUD tint + music later), gameplay
// `flags` other briefs read (pvp, traffic, water, …), and a `shape` for the
// point test. Listed in resolution priority: the FIRST shape that contains a
// point wins, so put specific places (Downtown) before broad ones (Wilds).
export const ZONES = [
	{
		id: 'downtown', label: 'Downtown', kind: 'safe',
		flags: { pvp: false, traffic: true, vendors: true, spawnSafe: true },
		shape: { type: 'circle', x: 0, z: 0, r: DISTRICT.plazaRadius + 8 },
	},
	{
		id: 'docks', label: 'The Docks', kind: 'neutral',
		flags: { pvp: false, traffic: true, water: true, cargo: true },
		shape: { type: 'rect', minX: 96, maxX: DISTRICT.half, minZ: -78, maxZ: 78 },
	},
	{
		id: 'wilds', label: 'The Wilds', kind: 'danger',
		flags: { pvp: true, traffic: false, loot: true },
		// The lawless outskirts: everything past this radius from the centre that
		// no more specific zone has already claimed.
		shape: { type: 'ring', x: 0, z: 0, r: 138 },
	},
];

// Anything not inside a listed zone is the ordinary street grid: neutral, with
// background traffic, no PvP.
export const DEFAULT_ZONE = Object.freeze({
	id: 'streets', label: 'The Streets', kind: 'neutral',
	flags: { pvp: false, traffic: true },
});

function inShape(shape, x, z) {
	switch (shape.type) {
		case 'circle':
			return Math.hypot(x - shape.x, z - shape.z) <= shape.r;
		case 'ring':
			return Math.hypot(x - shape.x, z - shape.z) >= shape.r;
		case 'rect':
			return x >= shape.minX && x <= shape.maxX && z >= shape.minZ && z <= shape.maxZ;
		default:
			return false;
	}
}

// Which zone is the point (x,z) in? Returns the first matching zone by priority,
// or DEFAULT_ZONE. Cheap enough to call per-frame for the local player.
export function zoneAt(x, z) {
	for (const zone of ZONES) {
		if (inShape(zone.shape, x, z)) return zone;
	}
	return DEFAULT_ZONE;
}

// --- Spawn-point registry --------------------------------------------------
// One table other briefs import. `type` partitions it: 'player' drop-ins (kept
// at the Downtown origin so the server's first-move anti-teleport check passes),
// 'vehicle' bays along the avenues (W02), 'vendor' stalls (economy briefs), and
// a 'race-grid' start line down the dock front (race briefs). yaw is the facing
// in radians. Adding a point here is how a later brief places a thing in the
// world without hand-coding coordinates twice.
export const SPAWN_POINTS = [
	// Player drop-ins — a tight ring on the Downtown plaza. Near the origin by
	// design: the server seeds every joiner at (0,0,0) and rejects a first move
	// farther than its max-step, so player spawns must sit within that radius.
	{ id: 'spawn-n', type: 'player', x: 0, z: -0.7, yaw: 0, zone: 'downtown' },
	{ id: 'spawn-e', type: 'player', x: 0.7, z: 0, yaw: -Math.PI / 2, zone: 'downtown' },
	{ id: 'spawn-s', type: 'player', x: 0, z: 0.7, yaw: Math.PI, zone: 'downtown' },
	{ id: 'spawn-w', type: 'player', x: -0.7, z: 0, yaw: Math.PI / 2, zone: 'downtown' },

	// Vehicle bays along the main cross avenues (consumed by W02 — vehicles).
	{ id: 'veh-north-ave', type: 'vehicle', x: 6, z: -90, yaw: 0, zone: 'streets' },
	{ id: 'veh-south-ave', type: 'vehicle', x: -6, z: 90, yaw: Math.PI, zone: 'streets' },
	{ id: 'veh-east-ave', type: 'vehicle', x: 90, z: 6, yaw: -Math.PI / 2, zone: 'docks' },
	{ id: 'veh-west-ave', type: 'vehicle', x: -90, z: -6, yaw: Math.PI / 2, zone: 'streets' },

	// Vendor stalls ringing Downtown (economy / shop briefs).
	{ id: 'vendor-ne', type: 'vendor', x: 44, z: -44, yaw: -Math.PI * 0.75, zone: 'streets' },
	{ id: 'vendor-sw', type: 'vendor', x: -44, z: 44, yaw: Math.PI * 0.25, zone: 'streets' },

	// The bank/ATM (W04) — one teller on the Downtown plaza, close enough to
	// spawn that a fresh player finds it without a hike, clear of both the
	// Agent Exchange roster (x ≈ -16..16) and the vendor stalls above.
	{ id: 'atm-downtown', type: 'atm', x: 0, z: -30, yaw: Math.PI, zone: 'downtown' },

	// Cosmetics boutique storefronts (W03) — mirrors the vendor stalls onto the
	// ring's other diagonal so the general-store clerks (vendor-ne/sw) and the
	// boutique never share a spot.
	{ id: 'boutique-se', type: 'boutique', x: 44, z: 44, yaw: Math.PI * 0.75, zone: 'streets' },
	{ id: 'boutique-nw', type: 'boutique', x: -44, z: -44, yaw: -Math.PI * 0.25, zone: 'streets' },

	// Race start grid down the dock front (race / mission briefs).
	{ id: 'race-dock-1', type: 'race-grid', x: 150, z: -10, yaw: Math.PI, zone: 'docks' },
	{ id: 'race-dock-2', type: 'race-grid', x: 150, z: 0, yaw: Math.PI, zone: 'docks' },
	{ id: 'race-dock-3', type: 'race-grid', x: 150, z: 10, yaw: Math.PI, zone: 'docks' },
];

// All spawn points of one type, in registry order.
export function spawnsOfType(type) {
	return SPAWN_POINTS.filter((s) => s.type === type);
}

// Pick a spawn point of a type. `rand` is an optional 0..1 source (seeded RNG or
// Math.random); omit it for the first/canonical point. Falls back to the origin
// so a caller asking for a type with no points still gets a usable spawn.
export function pickSpawn(type, rand) {
	const list = spawnsOfType(type);
	if (!list.length) return { id: `${type}-origin`, type, x: 0, z: 0, yaw: 0, zone: 'downtown' };
	const i = typeof rand === 'function' ? Math.floor(rand() * list.length) % list.length : 0;
	return list[i];
}

// The canonical drop-in: a player spawn jittered onto its micro-ring so two
// joiners never stack exactly on each other, while staying inside the server's
// first-move radius. Returns { x, z, yaw } in world metres.
export function playerSpawn(rand = Math.random) {
	const ring = spawnsOfType('player');
	const base = ring[Math.floor(rand() * ring.length) % ring.length] || { x: 0, z: 0, yaw: 0 };
	const a = rand() * Math.PI * 2;
	const r = 0.15 + rand() * 0.35;
	return { x: base.x + Math.cos(a) * r, z: base.z + Math.sin(a) * r, yaw: base.yaw };
}

// Square clamp to the playable bounds. Mirrors the server's authoritative clamp
// so client prediction and the server agree on the world's edge.
export function clampToBounds(x, z) {
	return {
		x: Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, x)),
		z: Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, z)),
	};
}

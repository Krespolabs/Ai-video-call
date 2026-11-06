// Combat math — the pure, server-authoritative core of the /play combat system
// (W07). Targeting geometry, damage + armor resolution, and the wanted/heat meter
// all live here as side-effect-light functions so the WalkRoom can stay a thin
// validator-and-replicator and every rule is unit-testable in isolation.
//
// Nothing here touches the network, the schema, or world geometry: the room feeds
// in authoritative positions (which it already holds from validated `move`s),
// weapon defs from items.js, and zone decisions from world-features.js, then
// applies the results. The client NEVER computes damage or picks hits — it only
// renders what these functions, run on the server, produce.
//
// Angle convention matches the client's avatar facing: yaw is measured as
// atan2(forwardX, forwardZ), so a player's forward vector is (sin yaw, cos yaw).

// Smallest signed difference between two angles, normalised to (-π, π].
export function angleDiff(a, b) {
	let d = a - b;
	while (d > Math.PI) d -= Math.PI * 2;
	while (d < -Math.PI) d += Math.PI * 2;
	return d;
}

// Bearing from one point to another in the yaw convention above.
export function bearing(from, to) {
	return Math.atan2(to.x - from.x, to.z - from.z);
}

export function dist2d(a, b) {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

// The authoritative target picker. Given the attacker's pose ({x, z, yaw}), the
// weapon def (from items.js WEAPONS), and the candidate entities (players + mobs,
// each {x, z, ...}), return the single entity the swing/shot lands on, or null.
//
//   melee  — candidate must be within `range` AND inside the frontal cone `arc`
//            (so you can't sword someone behind you).
//   ranged — candidate must be within `range` AND within `aimTol` of where the
//            attacker is facing (a light aim-assist on the hitscan line).
//
// Among all candidates that pass, the NEAREST is chosen — melee favours the foe in
// your face, ranged favours the first thing down your sights. Candidates the
// caller already excluded (self, dead, wrong zone) simply aren't passed in, so the
// gating policy stays in the room while the geometry stays here.
export function selectTarget(attacker, weapon, candidates) {
	if (!weapon || !Array.isArray(candidates)) return null;
	const isMelee = weapon.kind === 'melee';
	const tol = isMelee ? (weapon.arc || 0) / 2 : (weapon.aimTol || 0);
	let best = null;
	let bestDist = Infinity;
	for (const c of candidates) {
		const d = dist2d(attacker, c);
		if (d > weapon.range) continue;
		// A target essentially on top of the attacker has an unstable bearing —
		// always count it as in-arc rather than letting noise reject a point-blank hit.
		if (d > 0.05) {
			const off = Math.abs(angleDiff(bearing(attacker, c), attacker.yaw));
			if (off > tol) continue;
		}
		if (d < bestDist) { best = c; bestDist = d; }
	}
	return best;
}

// Roll a weapon's damage for one hit: base, scaled gently by the attacker's combat
// level (+1%/level so the skill matters without trivialising fights) and a ±15%
// swing for texture. `rng` is injectable so the room's roll is honest and this
// stays deterministic under test, mirroring items.js's roll helpers. Always ≥ 1.
export function rollDamage(weapon, combatLevel = 1, rng = Math.random) {
	const base = weapon?.dmg || 0;
	if (base <= 0) return 0;
	const lvl = Math.max(1, combatLevel | 0);
	const scaled = base * (1 + 0.01 * (lvl - 1));
	const varied = scaled * (0.85 + rng() * 0.30);
	return Math.max(1, Math.round(varied));
}

// Apply `dmg` to a target's vitals. Armor is a second health bar that absorbs
// damage 1:1 until depleted; the remainder spills into HP. Mutates the target
// ({hp, armor}) in place — server entities are plain mutable objects — and returns
// a breakdown for the hit feedback. `killed` is true when HP reaches 0.
export function applyDamage(target, dmg) {
	const d = Math.max(0, Math.round(dmg));
	const armor = Math.max(0, target.armor || 0);
	const armorAbsorbed = Math.min(armor, d);
	target.armor = armor - armorAbsorbed;
	const hpLost = d - armorAbsorbed;
	target.hp = Math.max(0, (target.hp || 0) - hpLost);
	return { dealt: d, armorAbsorbed, hpLost, killed: target.hp <= 0 };
}

// ---------------------------------------------------------------------------
// Wanted / heat (W07 v1)
// ---------------------------------------------------------------------------
//
// A lightweight crime meter. Attacking another player is a "crime" that raises
// heat; killing one raises it more. Heat decays over time, and faster while you
// lie low in a safe zone. The meter maps to 0–5 wanted stars peers can see (and,
// in W08, NPC enforcers will react to). Mob fights never raise heat — clearing the
// wilds is the intended, lawful loop.
export const MAX_HEAT = 5;
export const HEAT_PER_ATTACK = 0.5;
export const HEAT_PER_KILL = 1.5;
export const HEAT_DECAY_DANGER = 0.12; // heat/sec out in the wilds
export const HEAT_DECAY_SAFE = 0.5;    // heat/sec while lying low in town

// Heat to add for a hostile act against another player. A kill is the bigger
// crime; a plain hit still nudges the meter. Clamps the running total to MAX_HEAT.
export function addHeat(heat, { killed = false } = {}) {
	const add = killed ? HEAT_PER_KILL : HEAT_PER_ATTACK;
	return Math.min(MAX_HEAT, Math.max(0, heat || 0) + add);
}

// Decay heat over `dtMs`, faster in a safe zone. Pure; clamps at 0.
export function decayHeat(heat, dtMs, inSafe) {
	const rate = inSafe ? HEAT_DECAY_SAFE : HEAT_DECAY_DANGER;
	return Math.max(0, (heat || 0) - rate * (dtMs / 1000));
}

// The 0–5 star level shown for a heat value. 0 heat → not wanted.
export function heatStars(heat) {
	return Math.max(0, Math.min(MAX_HEAT, Math.ceil(heat || 0)));
}

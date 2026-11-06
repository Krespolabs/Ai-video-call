// Agora player mode — the PURE rules of embodied play. Everything here is
// deterministic math/state with no Three.js, DOM, or network imports, so the
// GTA-style layer (player-mode.js) stays unit-testable the same way the labor
// engine keeps its economics in workers/agora-citizens/policy.js.
//
// player-mode.js owns the scene objects and the wire; this module owns:
//   • camera-relative movement + facing            (stepMovement)
//   • the idle/walk/run motion state               (motionFor)
//   • capsule-vs-AABB building collision           (resolveBuildingCollision)
//   • who the player can interact with right now   (nearestInteractable)
//   • which avatar the player embodies             (chooseAvatarSource)
//   • a stable guest display name                  (guestName)

// Movement tuning — deliberately close to /city's controller so crossing
// between the two city-substrate worlds feels identical underfoot.
export const WALK_SPEED = 4.2; // m/s
export const RUN_SPEED = 8.5; // m/s
export const JUMP_VEL = 8.5; // m/s initial upward
export const GRAVITY = -22; // m/s²
export const PLAYER_RADIUS = 0.42; // collision capsule radius (m)

// A citizen (or the job board) is reachable for interaction inside this range.
export const INTERACT_RADIUS = 3.2; // metres

/**
 * The locomotion state for the animation mixer + the multiplayer wire.
 * Matches the WalkRoom Player.motion vocabulary: 'idle' | 'walk' | 'run'.
 */
export function motionFor(horizontalSpeed, running) {
	if (horizontalSpeed < 0.4) return 'idle';
	return running ? 'run' : 'walk';
}

/**
 * One movement step: camera-relative input → velocity + facing.
 * Pure: mutates nothing — returns the next {vx, vz, yaw, moving}.
 *
 * @param {object} args
 * @param {{forward:number, strafe:number}} args.input  each in [-1, 1] (keyboard
 *   fills ±1, a touch stick fills the analogue range)
 * @param {number} args.cameraYaw   horizontal camera angle (rad, three.js Y)
 * @param {boolean} args.running    sprint modifier held
 * @param {number} args.vx          current horizontal velocity x
 * @param {number} args.vz          current horizontal velocity z
 * @param {number} args.yaw         current facing (rad)
 * @param {number} args.dt          frame delta (s)
 */
export function stepMovement({ input, cameraYaw, running, vx, vz, yaw, dt }) {
	const f = clamp(input.forward, -1, 1);
	const s = clamp(input.strafe, -1, 1);
	// Camera-relative basis: forward = -Z rotated by cameraYaw.
	let dx = -Math.sin(cameraYaw) * f + Math.cos(cameraYaw) * s;
	let dz = -Math.cos(cameraYaw) * f - Math.sin(cameraYaw) * s;
	const len = Math.hypot(dx, dz);
	const moving = len > 0.08; // stick deadzone tail
	if (moving) {
		dx /= len;
		dz /= len;
		// Analogue magnitude scales speed so a gentle thumb = a stroll.
		const mag = Math.min(1, len);
		const speed = (running ? RUN_SPEED : WALK_SPEED) * mag;
		return { vx: dx * speed, vz: dz * speed, yaw: Math.atan2(dx, dz), moving: true };
	}
	// Quick exponential stop (frame-rate independent).
	const damp = Math.pow(0.02, dt);
	return { vx: vx * damp, vz: vz * damp, yaw, moving: false };
}

/**
 * Shortest-arc yaw easing so the avatar turns the short way round.
 * Returns the next yaw after easing `current` toward `target` by k·dt.
 */
export function easeYaw(current, target, dt, k = 14) {
	let diff = target - current;
	while (diff > Math.PI) diff -= Math.PI * 2;
	while (diff < -Math.PI) diff += Math.PI * 2;
	return current + diff * Math.min(1, dt * k);
}

/**
 * Capsule-vs-AABB push-out in the XZ plane — the same building collision the
 * City player uses, kept pure. `boxes` are {minX,maxX,minZ,maxZ,h} from
 * buildCity(); a player above a box's height clears it (jumping over stalls).
 *
 * @returns {{x:number, z:number}} the resolved position
 */
export function resolveBuildingCollision(nx, ny, nz, boxes, radius = PLAYER_RADIUS) {
	for (const b of boxes || []) {
		if (ny > b.h) continue;
		const cx = Math.max(b.minX, Math.min(b.maxX, nx));
		const cz = Math.max(b.minZ, Math.min(b.maxZ, nz));
		const ox = nx - cx;
		const oz = nz - cz;
		const dist2 = ox * ox + oz * oz;
		if (dist2 >= radius * radius) continue;
		const dist = Math.sqrt(dist2);
		if (dist < 0.001) {
			// Dead-centre inside the box — eject toward the nearest face.
			const toLeft = nx - b.minX;
			const toRight = b.maxX - nx;
			const toFront = nz - b.minZ;
			const toBack = b.maxZ - nz;
			const min = Math.min(toLeft, toRight, toFront, toBack);
			if (min === toLeft) nx = b.minX - radius;
			else if (min === toRight) nx = b.maxX + radius;
			else if (min === toFront) nz = b.minZ - radius;
			else nz = b.maxZ + radius;
		} else {
			const push = (radius - dist) / dist;
			nx += ox * push;
			nz += oz * push;
		}
	}
	return { x: nx, z: nz };
}

/**
 * Is a point clear of every building (outside all AABBs by at least `margin`)?
 * The OSM Manhattan substrate is dense, so a naive spawn can land inside a tower.
 */
export function isOpenGround(x, z, boxes, margin = PLAYER_RADIUS + 0.2) {
	for (const b of boxes || []) {
		if (x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin) {
			return false;
		}
	}
	return true;
}

/**
 * Find an open standing point near a desired spawn: spiral outward (golden-angle,
 * so samples never line up with a street grid and miss every gap) until a point
 * clear of all buildings is found. Falls back to the desired point if the whole
 * search is walled (a degenerate map) — the player is never left unplaced.
 * Pure: no Three.js, so it's unit-tested with plain AABBs.
 *
 * @returns {{x:number, z:number}}
 */
export function findOpenSpawn(desired, boxes, { maxRadius = 60, step = 0.7 } = {}) {
	if (isOpenGround(desired.x, desired.z, boxes)) return { x: desired.x, z: desired.z };
	const GOLDEN = 2.399963229728653;
	for (let i = 1; i * step < maxRadius; i++) {
		const r = step * Math.sqrt(i);
		const a = i * GOLDEN;
		const x = desired.x + Math.cos(a) * r;
		const z = desired.z + Math.sin(a) * r;
		if (isOpenGround(x, z, boxes)) return { x, z };
	}
	return { x: desired.x, z: desired.z };
}

/**
 * The single nearest interactable within reach — drives the "press E" prompt.
 * Candidates carry {id, kind, x, z, ...} (kind: 'citizen' | 'board' | …);
 * the caller shapes the prompt from the winner's fields. Deterministic
 * tie-break by distance then id so the prompt never flickers between two
 * equidistant citizens.
 *
 * @returns {object|null} the winning candidate + its distance, or null
 */
export function nearestInteractable(px, pz, candidates, radius = INTERACT_RADIUS) {
	let best = null;
	let bestD = radius;
	for (const c of candidates || []) {
		const d = Math.hypot(c.x - px, c.z - pz);
		if (d < bestD || (best && d === bestD && String(c.id) < String(best.id))) {
			best = c;
			bestD = d;
		}
	}
	return best ? { ...best, distance: bestD } : null;
}

/**
 * Which avatar the player embodies, in priority order:
 *   1. ?avatarUrl=<direct GLB/VRM url>       (deep link, same as /temporary)
 *   2. ?avatar=<three.ws avatar id or url>   (deep link)
 *   3. the last avatar they walked as here   (localStorage 'agora:avatar')
 *   4. '' → avatar-rig's default             (never a blank world)
 * Pure: takes the parsed params + a storage getter so tests inject both.
 *
 * @param {URLSearchParams|Map} params
 * @param {(key:string) => string|null} getStored
 * @returns {{source:string, value:string}}
 */
export function chooseAvatarSource(params, getStored) {
	const direct = (params.get('avatarUrl') || '').trim();
	if (direct) return { source: 'param-url', value: direct };
	const byId = (params.get('avatar') || '').trim();
	if (byId) return { source: 'param', value: byId };
	const stored = (getStored('agora:avatar') || '').trim();
	if (stored) return { source: 'stored', value: stored };
	return { source: 'default', value: '' };
}

/**
 * A stable, human-friendly guest name. Reuses the stored one so a returning
 * visitor keeps their identity in the square; otherwise derives 'visitor-xxxx'
 * from the supplied entropy (caller passes randomness — pure function).
 */
export function guestName(getStored, entropy) {
	const stored = (getStored('agora:name') || '').trim();
	if (stored) return stored.slice(0, 24);
	const tag = Math.abs(Math.floor(entropy * 46656)) // 36^3
		.toString(36)
		.padStart(3, '0')
		.slice(0, 3);
	return `visitor-${tag}`;
}

function clamp(v, min, max) {
	const n = Number(v) || 0;
	return Math.max(min, Math.min(max, n));
}

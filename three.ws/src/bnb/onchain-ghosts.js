/**
 * Pure on-chain presence ghost-state tracker (prompt 16).
 *
 * Turns a stream of `Moved` events (arbitrary player address → contract-unit
 * position/facing, timestamped) into smoothly interpolated render state, and
 * drops a player who hasn't moved in a while. No THREE.js, no DOM, no
 * network — feed it timestamped positions, call `tick(dt)` every frame, read
 * back interpolated `{x,y,z,facing}` per player. Framework-agnostic on
 * purpose so it's unit-testable without a WebGL context (tests/bnb-onchain-
 * ghosts.test.js) and so a future non-Three renderer could reuse it.
 *
 * Coordinates here are WHATEVER unit the caller feeds in (contract int32
 * units or engine meters — this module doesn't care, it just lerps numbers).
 * `src/agora/onchain-presence.js` is the THREE.js-aware caller that converts
 * WorldMoves' millimeter/centidegree units to scene meters/radians before
 * handing positions to `upsert`.
 */

/** No `Moved` event for this long (ms) → the ghost is dropped as stale. */
export const GHOST_STALE_MS = 6000;

/** Exponential-lerp factor per 60fps-equivalent frame (matches player-mode.js's REMOTE_LERP for other humans, so on-chain ghosts move with the same "weight"). */
export const GHOST_LERP = 0.22;

/** Wrap-aware shortest-path interpolation between two headings in [0, range). */
function easeAngle(current, target, k, range) {
	let diff = ((target - current + range * 1.5) % range) - range / 2;
	return (((current + diff * k) % range) + range) % range;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.staleMs] drop a player after this long without a fresh event
 * @param {number} [opts.lerp] exponential-lerp factor per 60fps-equivalent frame
 * @param {number} [opts.facingRange] wrap range for facing interpolation (WorldMoves centidegrees: 36000)
 * @param {() => number} [opts.now] injectable clock (tests)
 */
export function createGhostTracker(opts = {}) {
	const staleMs = opts.staleMs ?? GHOST_STALE_MS;
	const lerp = opts.lerp ?? GHOST_LERP;
	const facingRange = opts.facingRange ?? 36000;
	const now = opts.now || (() => Date.now());

	/** @type {Map<string, { player:string, x:number, y:number, z:number, facing:number, target:{x:number,y:number,z:number,facing:number}, firstSeen:number, lastSeen:number, moves:number }>} */
	const byPlayer = new Map();

	return {
		/**
		 * Record a fresh on-chain position for `player` (lowercase address or any
		 * stable key). First sighting snaps instantly (no lerping in from the
		 * origin); every subsequent sighting updates the interpolation target.
		 * @returns {{isNew:boolean}}
		 */
		upsert(player, { x, y, z, facing = 0 }, timestamp = now()) {
			const key = String(player).toLowerCase();
			let g = byPlayer.get(key);
			const isNew = !g;
			if (!g) {
				g = { player: key, x, y, z, facing, target: { x, y, z, facing }, firstSeen: timestamp, lastSeen: timestamp, moves: 0 };
				byPlayer.set(key, g);
			} else {
				g.target = { x, y, z, facing };
				g.lastSeen = timestamp;
				g.moves += 1;
			}
			return { isNew };
		},

		/**
		 * Advance interpolation by `dt` seconds and drop anyone stale as of
		 * `atMs`. Returns the list of player keys dropped this tick (caller
		 * disposes their render objects).
		 */
		tick(dt, atMs = now()) {
			const dead = [];
			const k = 1 - Math.pow(1 - lerp, Math.max(0, dt) * 60);
			for (const [key, g] of byPlayer) {
				if (atMs - g.lastSeen > staleMs) {
					dead.push(key);
					continue;
				}
				g.x += (g.target.x - g.x) * k;
				g.y += (g.target.y - g.y) * k;
				g.z += (g.target.z - g.z) * k;
				g.facing = easeAngle(g.facing, g.target.facing, k, facingRange);
			}
			for (const key of dead) byPlayer.delete(key);
			return dead;
		},

		/** Explicitly drop one player (e.g. a real-time `Left` event). */
		remove(player) {
			return byPlayer.delete(String(player).toLowerCase());
		},

		get(player) {
			return byPlayer.get(String(player).toLowerCase());
		},

		values() {
			return byPlayer.values();
		},

		get size() {
			return byPlayer.size;
		},

		clear() {
			byPlayer.clear();
		},
	};
}

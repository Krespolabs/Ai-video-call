// Pure helpers for resolving named empties inside the authored club venue
// GLB. Lifted out of src/club.js so they can be unit-tested without booting
// a WebGLRenderer / DOM. The runtime imports both symbols from here.

import { Vector3 } from 'three';

/**
 * Named empties the venue GLB MUST expose for the runtime to bind dancers
 * + lighting to authored positions. The per-pole suffixes are zero-padded
 * two-digit strings so artists can re-order discs in Blender without
 * renaming the empties. Missing any of these is a load-time error.
 *
 * Names use underscores rather than dots because three.js's GLTFLoader
 * runs `PropertyBinding.sanitizeNodeName` on every loaded node and strips
 * the characters `[ ] . : /`. A node authored as `truss.spot.01` in
 * Blender would arrive at runtime as `trussspot01` — the underscore form
 * survives the sanitizer untouched. Artists should mirror this convention
 * when naming empties in the .blend file.
 */
export const REQUIRED_VENUE_EMPTIES = [
	'truss_mirrorball',
	'bar_backsplash_neon',
	'stage_01',
	'stage_02',
	'stage_03',
	'stage_04',
	'backstage_door_01',
	'backstage_door_02',
	'backstage_door_03',
	'backstage_door_04',
	'truss_spot_01',
	'truss_spot_02',
	'truss_spot_03',
	'truss_spot_04',
];

/**
 * Walk the venue scene graph and return every required named empty as a
 * Map keyed by name. Throws with the missing-empty list if anything from
 * `required` is absent — the spec is explicit that we surface the error
 * rather than silently falling back to analytical positions.
 *
 * @param {import('three').Object3D} root
 * @param {string[]} [required] — defaults to REQUIRED_VENUE_EMPTIES.
 * @returns {Map<string, import('three').Object3D>}
 */
export function collectVenueEmpties(root, required = REQUIRED_VENUE_EMPTIES) {
	if (!root || typeof root.traverse !== 'function') {
		throw new Error('collectVenueEmpties: expected an Object3D with .traverse()');
	}
	const requiredSet = new Set(required);
	const found = new Map();
	root.traverse((n) => {
		if (n && typeof n.name === 'string' && requiredSet.has(n.name)) {
			found.set(n.name, n);
		}
	});
	const missing = required.filter((name) => !found.has(name));
	if (missing.length) {
		throw new Error(
			`Venue GLB is missing required named empties: ${missing.join(', ')}. ` +
				'Author them in Blender and re-export — the runtime has no fallback.',
		);
	}
	return found;
}

/**
 * For a fixed pole count, harvest the world positions of the
 * stage / backstage / spot empties as flat Vector3 arrays. Lets the
 * bootstrap loop and the tests share one indexing rule (zero-padded two-
 * digit slot suffixes starting at 01).
 *
 * Returns the underlying anchor Object3Ds for `mirrorball` and
 * `barBacksplashNeon` so callers can either read their world position or
 * attach children directly (prompt 04 mounts the mirror ball + bar neon
 * strip as children of these empties).
 *
 * @param {Map<string, import('three').Object3D>} empties
 * @param {number} slotCount
 * @returns {{
 *   stages: Vector3[],
 *   backstages: Vector3[],
 *   spots: Vector3[],
 *   mirrorball: import('three').Object3D,
 *   barBacksplashNeon: import('three').Object3D,
 * }}
 */
export function resolveVenueAnchors(empties, slotCount) {
	const stages = [];
	const backstages = [];
	const spots = [];
	for (let i = 0; i < slotCount; i += 1) {
		const id = String(i + 1).padStart(2, '0');
		stages.push(empties.get(`stage_${id}`).getWorldPosition(new Vector3()));
		backstages.push(empties.get(`backstage_door_${id}`).getWorldPosition(new Vector3()));
		spots.push(empties.get(`truss_spot_${id}`).getWorldPosition(new Vector3()));
	}
	return {
		stages,
		backstages,
		spots,
		mirrorball: empties.get('truss_mirrorball'),
		barBacksplashNeon: empties.get('bar_backsplash_neon'),
	};
}

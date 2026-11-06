/**
 * pose-solve — pure landmark → humanoid bone rotation solver.
 *
 * Input: MediaPipe Pose **world** landmarks (BlazePose GHUM, 33 points, metres,
 * origin at the hip midpoint) as produced by `@mediapipe/tasks-vision`'s
 * PoseLandmarker `worldLandmarks`. Each landmark is `{ x, y, z, visibility }`.
 *
 * Output: a map of canonical bone name → THREE.Quaternion, where each quaternion
 * is the bone's **world-space orientation delta from its rest (T-pose) direction**
 * — i.e. the rotation that takes the bone's rest axis onto the measured limb
 * direction. The runtime (`BodyMocap`) converts these world deltas into each
 * bone's parent-local frame before applying them, which keeps this module pure
 * and free of any scene-graph dependency so it can be unit-tested in isolation.
 *
 * This is the same family of math Kalidokit performs, re-implemented in-repo to
 * avoid a new dependency (the codebase already hand-rolls its mocap helpers — see
 * the note in face-mocap.js). It is deliberately solver-only: no DOM, no webcam,
 * no three-vrm coupling.
 *
 * Coordinate conventions
 * ──────────────────────
 *   MediaPipe world space:  +x → subject's right (in image), +y → down, +z → toward camera
 *   Avatar space (Mixamo):  +x → character's left, +y → up, +z → forward (toward viewer)
 *
 * The avatar T-pose rest directions (direction a bone points from its head to its
 * child) are therefore:
 *   LeftArm / LeftForeArm   → +x
 *   RightArm / RightForeArm → −x
 *   LeftUpLeg / LeftLeg     → −y   (down)
 *   RightUpLeg / RightLeg   → −y
 *   Spine / Spine1 / Spine2 → +y   (up)
 */

import { Vector3, Quaternion } from 'three';

// ── MediaPipe BlazePose landmark indices ─────────────────────────────────────
export const LM = Object.freeze({
	LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
	LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
	LEFT_WRIST: 15, RIGHT_WRIST: 16,
	LEFT_HIP: 23, RIGHT_HIP: 24,
	LEFT_KNEE: 25, RIGHT_KNEE: 26,
	LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
});

// Rest (T-pose) bone direction unit vectors in avatar space.
export const REST_DIR = Object.freeze({
	LeftArm:      new Vector3( 1,  0, 0),
	LeftForeArm:  new Vector3( 1,  0, 0),
	RightArm:     new Vector3(-1,  0, 0),
	RightForeArm: new Vector3(-1,  0, 0),
	LeftUpLeg:    new Vector3( 0, -1, 0),
	LeftLeg:      new Vector3( 0, -1, 0),
	RightUpLeg:   new Vector3( 0, -1, 0),
	RightLeg:     new Vector3( 0, -1, 0),
	Spine:        new Vector3( 0,  1, 0),
});

const DEFAULT_MIN_VISIBILITY = 0.5;

// Reusable scratch vectors so the hot path allocates nothing per frame.
const _a = new Vector3();
const _b = new Vector3();
const _dir = new Vector3();

/**
 * Map a MediaPipe world landmark into avatar space.
 * @param {{x:number,y:number,z:number}} lm
 * @param {boolean} mirror — when true, flips X so the avatar mirrors the user
 *   (raise your right hand, the avatar's right hand — as seen by you — rises).
 * @param {Vector3} out
 */
export function landmarkToAvatar(lm, mirror, out = new Vector3()) {
	const x = mirror ? -lm.x : lm.x;
	// MP +y is down and +z is toward camera; avatar +y is up and +z is forward.
	return out.set(x, -lm.y, -lm.z);
}

function visible(lm, min) {
	return lm && (lm.visibility == null || lm.visibility >= min);
}

/**
 * Solve a limb segment into a world-space rest→target delta quaternion.
 * @returns {Quaternion|null} null when either endpoint is missing/occluded.
 */
function solveSegment(from, to, restDir, mirror, minVis) {
	if (!visible(from, minVis) || !visible(to, minVis)) return null;
	landmarkToAvatar(from, mirror, _a);
	landmarkToAvatar(to, mirror, _b);
	_dir.subVectors(_b, _a);
	if (_dir.lengthSq() < 1e-8) return null;
	_dir.normalize();
	return new Quaternion().setFromUnitVectors(restDir, _dir);
}

/**
 * Solve a full pose frame.
 *
 * @param {Array<{x:number,y:number,z:number,visibility?:number}>} world — 33 world landmarks
 * @param {object} [opts]
 * @param {boolean} [opts.mirror=false]       mirror left/right for a selfie feel
 * @param {boolean} [opts.legs=true]          solve legs (noisy when seated; callers can disable)
 * @param {number}  [opts.minVisibility=0.5]  drop joints below this confidence
 * @returns {{ bones: Record<string, Quaternion>, missing: string[] }}
 *   `bones` holds only the segments that solved this frame; `missing` lists the
 *   canonical names that were dropped (occluded / low confidence) so the runtime
 *   can hold the previous rotation instead of snapping to rest.
 */
export function solvePose(world, opts = {}) {
	const mirror = opts.mirror ?? false;
	const legs = opts.legs ?? true;
	const minVis = opts.minVisibility ?? DEFAULT_MIN_VISIBILITY;

	const bones = {};
	const missing = [];
	if (!Array.isArray(world) || world.length < 25) {
		return { bones, missing: ['__no_pose__'] };
	}

	const seg = (name, fromIdx, toIdx) => {
		const q = solveSegment(world[fromIdx], world[toIdx], REST_DIR[name], mirror, minVis);
		if (q) bones[name] = q; else missing.push(name);
	};

	// Arms — the reliable signal from a single front-facing webcam.
	seg('LeftArm',      LM.LEFT_SHOULDER,  LM.LEFT_ELBOW);
	seg('LeftForeArm',  LM.LEFT_ELBOW,     LM.LEFT_WRIST);
	seg('RightArm',     LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW);
	seg('RightForeArm', LM.RIGHT_ELBOW,    LM.RIGHT_WRIST);

	// Spine lean — derived from the shoulder-midpoint over the hip-midpoint.
	const spine = solveSpine(world, mirror, minVis);
	if (spine) bones.Spine = spine; else missing.push('Spine');

	if (legs) {
		seg('LeftUpLeg',  LM.LEFT_HIP,   LM.LEFT_KNEE);
		seg('LeftLeg',    LM.LEFT_KNEE,  LM.LEFT_ANKLE);
		seg('RightUpLeg', LM.RIGHT_HIP,  LM.RIGHT_KNEE);
		seg('RightLeg',   LM.RIGHT_KNEE, LM.RIGHT_ANKLE);
	}

	return { bones, missing };
}

/**
 * Spine lean from hip-midpoint → shoulder-midpoint, relative to straight-up.
 * @returns {Quaternion|null}
 */
export function solveSpine(world, mirror, minVis = DEFAULT_MIN_VISIBILITY) {
	const ls = world[LM.LEFT_SHOULDER], rs = world[LM.RIGHT_SHOULDER];
	const lh = world[LM.LEFT_HIP], rh = world[LM.RIGHT_HIP];
	if (![ls, rs, lh, rh].every((p) => visible(p, minVis))) return null;

	landmarkToAvatar(ls, mirror, _a);
	landmarkToAvatar(rs, mirror, _b);
	const shoulderMid = _a.clone().add(_b).multiplyScalar(0.5);

	landmarkToAvatar(lh, mirror, _a);
	landmarkToAvatar(rh, mirror, _b);
	const hipMid = _a.clone().add(_b).multiplyScalar(0.5);

	_dir.subVectors(shoulderMid, hipMid);
	if (_dir.lengthSq() < 1e-8) return null;
	_dir.normalize();
	return new Quaternion().setFromUnitVectors(REST_DIR.Spine, _dir);
}

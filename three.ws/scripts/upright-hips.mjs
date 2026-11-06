/**
 * upright-hips.mjs — remove a constant Hips orientation bias from a baked clip.
 *
 * Some source skeletons store their up-axis convention (the Y-up→Z-up rotation
 * Blender/Maya bakes on export) on the Hips bone's LOCAL track rather than on a
 * parent armature node. three.js's `Soldier.glb` and `Michelle.glb` are exactly
 * this case: the −90°X / +90°X conversion rides on the animated Hips itself. The
 * extract → retarget pipeline copies the Hips track verbatim onto a canonical
 * (identity-rest) rig, so the conversion is no longer cancelled by a parent and
 * the whole body lies on its back. The runtime fallen-pose guard then correctly
 * rejects the clip (~90° off vertical) and the avatar falls back to bind pose —
 * which is what produced the `fallen-pose retarget` reports for `samba-dance`
 * and the soldier idle/walk/run clips.
 *
 * The fix is to fold that constant bias out of the clip: the bias is a single
 * rotation applied in the Hips' parent frame, so pre-multiplying every Hips
 * keyframe quaternion by its inverse — and rotating every Hips position keyframe
 * by the same inverse — re-stands the entire animation upright while leaving the
 * internal pose (every child bone, relative to the Hips) byte-for-byte untouched.
 * It is the precise inverse of the missing parent node, not a heuristic reshape.
 *
 * Sources that already export upright (Xbot/Robot GLBs, every Mixamo FBX) carry
 * no bias, so this is opt-in per source via `uprightFix` in animations.config.json
 * — an authored bent pose (a yoga fold, a crouch) is never silently straightened.
 * The function is self-gating regardless: a clip already within tolerance of
 * vertical is returned unchanged, so applying it twice — or to a healthy clip —
 * is a no-op.
 *
 * Operates on the three.js `AnimationClip.toJSON()` shape (`{ tracks: [{ name,
 * type, times, values }] }`) so the same routine corrects the build output and
 * repairs already-committed clip JSON.
 */

// At-rest Hips tilt (degrees off vertical) above which a clip is treated as
// carrying a baked bias worth removing. Healthy clips peak at ~30° of authored
// lean (the `dance` choreography); a parent-frame bias lands near 90°. 45° sits
// cleanly between — and equals the runtime guard's catastrophe threshold, so
// "would the guard reject this at rest?" and "does this need correcting?" agree.
const BIAS_THRESHOLD_DEG = 45;

function qMul(a, b) {
	return [
		a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
		a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
		a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
		a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
	];
}

function qNormalize(q) {
	const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
	return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

// Rotate a vector by a unit quaternion (q · v · q⁻¹), the standard expansion.
function qRotateVec(q, v) {
	const [x, y, z, w] = q;
	const [vx, vy, vz] = v;
	const tx = 2 * (y * vz - z * vy);
	const ty = 2 * (z * vx - x * vz);
	const tz = 2 * (x * vy - y * vx);
	return [
		vx + w * tx + (y * tz - z * ty),
		vy + w * ty + (z * tx - x * tz),
		vz + w * tz + (x * ty - y * tx),
	];
}

// World up-axis a Hips quaternion imposes (its local +Y in world space).
function hipsUp(q) {
	return qRotateVec(q, [0, 1, 0]);
}

function tiltDeg(up) {
	return (Math.acos(Math.max(-1, Math.min(1, up[1]))) * 180) / Math.PI;
}

// Shortest-arc unit quaternion rotating unit vector `from` onto unit vector `to`.
function quatFromTo(from, to) {
	const d = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
	if (d > 0.999999) return [0, 0, 0, 1];
	if (d < -0.999999) {
		// Antiparallel: rotate 180° about any axis perpendicular to `from`.
		let axis = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
		const c = [
			from[1] * axis[2] - from[2] * axis[1],
			from[2] * axis[0] - from[0] * axis[2],
			from[0] * axis[1] - from[1] * axis[0],
		];
		const l = Math.hypot(c[0], c[1], c[2]) || 1;
		return [c[0] / l, c[1] / l, c[2] / l, 0];
	}
	const c = [
		from[1] * to[2] - from[2] * to[1],
		from[2] * to[0] - from[0] * to[2],
		from[0] * to[1] - from[1] * to[0],
	];
	return qNormalize([c[0], c[1], c[2], 1 + d]);
}

function findTrack(clipJson, suffix) {
	return (clipJson.tracks || []).find(
		(t) => typeof t.name === 'string' && t.name.endsWith(suffix),
	);
}

/**
 * Re-stand a clip whose Hips track carries a constant parent-frame orientation
 * bias. Mutates the clip's Hips quaternion + position track values in place.
 *
 * @param {{ tracks: Array<{ name: string, type?: string, times: number[], values: number[] }> }} clipJson
 * @returns {{ changed: boolean, tiltBefore: number, tiltAfter: number, reason?: string }}
 */
export function liftHipsUpright(clipJson) {
	const quat = findTrack(clipJson, 'Hips.quaternion');
	if (!quat || !quat.values || quat.values.length < 4) {
		return { changed: false, tiltBefore: 0, tiltAfter: 0, reason: 'no-hips-quaternion' };
	}

	const v = quat.values;
	const frames = v.length / 4;

	// Mean imposed up-axis across the clip — robust to per-frame motion, so a
	// transient lean (a dance dip) doesn't skew the bias estimate.
	const mean = [0, 0, 0];
	for (let i = 0; i < frames; i++) {
		const o = i * 4;
		const up = hipsUp([v[o], v[o + 1], v[o + 2], v[o + 3]]);
		mean[0] += up[0];
		mean[1] += up[1];
		mean[2] += up[2];
	}
	const ml = Math.hypot(mean[0], mean[1], mean[2]) || 1;
	const meanUp = [mean[0] / ml, mean[1] / ml, mean[2] / ml];

	const tiltBefore = tiltDeg([v[0], v[1], v[2], v[3]]);
	// Self-gate: a clip whose mean up-axis is already near vertical carries no
	// bias to remove. Returning unchanged makes the routine idempotent and safe
	// to run on healthy clips.
	if (tiltDeg(meanUp) <= BIAS_THRESHOLD_DEG) {
		return { changed: false, tiltBefore, tiltAfter: tiltBefore, reason: 'already-upright' };
	}

	// The correction is the rotation that maps the baked mean up-axis back to
	// world vertical — the inverse of the missing parent node.
	const correction = quatFromTo(meanUp, [0, 1, 0]);

	for (let i = 0; i < frames; i++) {
		const o = i * 4;
		const q = qNormalize(qMul(correction, [v[o], v[o + 1], v[o + 2], v[o + 3]]));
		v[o] = q[0];
		v[o + 1] = q[1];
		v[o + 2] = q[2];
		v[o + 3] = q[3];
	}

	// The Hips position track lives in the same (biased) parent frame, so the
	// root trajectory is rotated by the identical correction — otherwise forward
	// travel leaks into the vertical axis (the soldier-walk Y reaching 6.5 m).
	const pos = findTrack(clipJson, 'Hips.position');
	if (pos && pos.values && pos.values.length >= 3) {
		const p = pos.values;
		for (let i = 0; i + 2 < p.length; i += 3) {
			const r = qRotateVec(correction, [p[i], p[i + 1], p[i + 2]]);
			p[i] = r[0];
			p[i + 1] = r[1];
			p[i + 2] = r[2];
		}
	}

	const tiltAfter = tiltDeg([v[0], v[1], v[2], v[3]]);
	return { changed: true, tiltBefore, tiltAfter };
}

export { BIAS_THRESHOLD_DEG };

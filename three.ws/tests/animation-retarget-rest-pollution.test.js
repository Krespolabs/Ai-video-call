/**
 * Regression lock — the "play one clip, the next mangles the rig" bug.
 *
 * The /pose Animation Studio previews a clip by retargeting it onto the live
 * rig with an AnimationMixer. retargetClipToRig() measures the rig's bind pose
 * (its rest local + world rotations, hip height, hips-parent frame) from the
 * rig's LIVE bone transforms to build the per-bone bind correction. But a mixer
 * leaves the bones mid-animation after a clip plays — so the SECOND clip a user
 * clicked was retargeted against a garbage "rest". On a Mixamo-convention rig
 * (michelle.glb: −90°X Hips, T-pose arms) the upper arm came out ~60° off and
 * the forearm ~90° off — the avatar walked with its arms stuck overhead.
 *
 * The fix: retargetClipToRig() restores the rig to its bind pose before reading
 * it (the caller's mixer re-poses on the next frame, so it's invisible). This
 * suite locks it by driving the REAL GltfRig (src/pose-rig.js) over the
 * committed michelle.glb: retargeting a clip after the rig was left mid-pose
 * must produce the SAME limb rotations as retargeting it from a fresh bind pose.
 *
 * Plain Node — the bone graph is reconstructed from the GLB's JSON chunk (no
 * GLTFLoader, no decoders, no network), so it gates every build.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Quaternion } from 'three';
import { loadBoneGraph } from './_helpers/glb-bone-graph.js';
import {
	canonicalNodeMapFromObject,
	retargetClipToRig,
	parseClipJSON,
} from '../src/animation-retarget.js';
import { makeGltfRig } from '../src/pose-rig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const avatar = (name) => resolve(repoRoot, 'public/avatars', name);
const clip = (name) =>
	parseClipJSON(
		JSON.parse(
			readFileSync(resolve(repoRoot, 'public/animations/clips', `${name}.json`), 'utf8'),
		),
		name,
	);

// Stamp a clip's pose at a fraction through its keyframes onto the live graph —
// a faithful stand-in for an AnimationMixer that played a clip and left the
// bones posed when the user clicked the next one.
function poseRigAt(root, map, c, frac) {
	for (const t of c.tracks) {
		const dot = t.name.indexOf('.');
		const bone = t.name.slice(0, dot);
		const prop = t.name.slice(dot + 1);
		const node = root.getObjectByName(map.get(bone) || bone);
		if (!node || prop !== 'quaternion') continue;
		const n = t.times.length;
		const k = Math.min(n - 1, Math.floor(frac * n));
		const o = k * 4;
		node.quaternion.set(t.values[o], t.values[o + 1], t.values[o + 2], t.values[o + 3]);
	}
	root.updateMatrixWorld(true);
}

// Park the graph on a retargeted clip's first frame so we can read the resulting
// world-space limb rotations — what the viewer would actually render.
function applyFrame0(root, retargeted) {
	for (const t of retargeted.tracks) {
		if (!t.name.endsWith('.quaternion')) continue;
		const node = root.getObjectByName(t.name.split('.')[0]);
		if (!node) continue;
		node.quaternion.set(t.values[0], t.values[1], t.values[2], t.values[3]);
	}
	root.updateMatrixWorld(true);
}

const worldQuat = (root, name) => {
	const q = new Quaternion();
	root.getObjectByName(name).getWorldQuaternion(q);
	return q;
};
// Angle (deg) between two rotations, sign-agnostic (q and −q are the same rot).
const angleDeg = (a, b) => {
	const d = Math.min(1, Math.abs(a.dot(b)));
	return (2 * Math.acos(d) * 180) / Math.PI;
};

// Limbs whose skew was the visible symptom; tolerance is generous FP slack —
// a clean retarget reproduces the reference to within ~0.01°.
const LIMBS = ['LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'LeftUpLeg', 'RightLeg'];
const SAME_DEG = 0.5;
// The pre-fix skew floor: on michelle the polluted path threw limbs tens of
// degrees off. We assert the teeth at a conservative 25° so the lock can't pass
// vacuously if the simulated pollution ever stopped perturbing the rig.
const CATASTROPHE_DEG = 25;

describe('retarget reads the rig bind pose, not a leftover preview pose', () => {
	const SWITCHES = [
		['wave', 'walk'],
		['jump', 'idle'],
		['celebrate', 'walk'],
	];

	for (const [first, second] of SWITCHES) {
		it(`michelle: ${second} after ${first} matches ${second} from bind`, () => {
			// Reference: a fresh rig, retarget `second` straight from bind pose.
			const ref = loadBoneGraph(avatar('michelle.glb'));
			const map = canonicalNodeMapFromObject(ref.root);
			const refRig = makeGltfRig(ref.root);
			expect(refRig).not.toBeNull();
			const refClip = retargetClipToRig(clip(second), refRig).clip;
			expect(refClip).not.toBeNull();
			applyFrame0(ref.root, refClip);
			const reference = LIMBS.map((b) => worldQuat(ref.root, map.get(b)));

			// Subject: same rig, but a prior preview left it posed mid-`first`, then
			// the user clicks `second`. With the fix the retarget restores bind first.
			const sub = loadBoneGraph(avatar('michelle.glb'));
			const subRig = makeGltfRig(sub.root);
			poseRigAt(sub.root, map, clip(first), 0.5);
			const subClip = retargetClipToRig(clip(second), subRig).clip;
			expect(subClip).not.toBeNull();
			applyFrame0(sub.root, subClip);

			LIMBS.forEach((b, i) => {
				const err = angleDeg(reference[i], worldQuat(sub.root, map.get(b)));
				expect(err, `${b} drifted ${err.toFixed(1)}° after switching clips`).toBeLessThan(
					SAME_DEG,
				);
			});
		});
	}

	it('the test has teeth: without the bind-pose restore, a clip switch mangles the limbs', () => {
		// Prove the fix is load-bearing. Reproduce the broken path by reading the
		// rest from the leftover pose ourselves (retargetClipToRig WITHOUT the
		// internal reset would do exactly this) and confirm the limbs blow up.
		const ref = loadBoneGraph(avatar('michelle.glb'));
		const map = canonicalNodeMapFromObject(ref.root);
		const refRig = makeGltfRig(ref.root);
		const refClip = retargetClipToRig(clip('walk'), refRig).clip;
		applyFrame0(ref.root, refClip);
		const reference = LIMBS.map((b) => worldQuat(ref.root, map.get(b)));

		const sub = loadBoneGraph(avatar('michelle.glb'));
		const subRig = makeGltfRig(sub.root);
		poseRigAt(sub.root, map, clip('wave'), 0.5);
		// Defeat the fix: a rig that ignores resetPose() leaves the polluted pose
		// in place, mirroring the pre-fix retargetClipToRig behaviour.
		subRig.resetPose = () => {};
		const subClip = retargetClipToRig(clip('walk'), subRig).clip;
		applyFrame0(sub.root, subClip);

		const worst = Math.max(
			...LIMBS.map((b, i) => angleDeg(reference[i], worldQuat(sub.root, map.get(b)))),
		);
		expect(worst).toBeGreaterThan(CATASTROPHE_DEG);
	});
});

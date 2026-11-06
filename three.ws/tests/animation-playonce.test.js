/**
 * AnimationManager.playOnce / freeze — unit tests.
 *
 * playOnce is the seamless one-shot path: a `loop:false` clip plays exactly once
 * then settles into idle via crossfade, instead of clamping and freezing on its
 * last frame (which reads as a hard snap on a looping thumbnail). freeze holds
 * the current pose and releases the active action so the render loop can idle —
 * the prefers-reduced-motion path.
 *
 * Builds a synthetic canonical rig + in-memory clips (no GLB, no fetch) so the
 * suite is fast and deterministic, mirroring animation-retarget.test.js.
 */

import { describe, it, expect } from 'vitest';
import {
	Bone,
	SkinnedMesh,
	Skeleton,
	BufferGeometry,
	QuaternionKeyframeTrack,
	VectorKeyframeTrack,
	AnimationClip,
	Object3D,
	LoopOnce,
	LoopRepeat,
} from 'three';
import { AnimationManager } from '../src/animation-manager.js';

// Eight canonical bones clears MIN_CANONICAL_BONES and gives the test clips
// full coverage so attach() builds real actions.
const RIG_BONES = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftUpLeg'];

function makeRig(boneNames = RIG_BONES) {
	const root = new Object3D();
	const bones = boneNames.map((name) => {
		const b = new Bone();
		b.name = name;
		return b;
	});
	for (const b of bones) root.add(b);
	const mesh = new SkinnedMesh(new BufferGeometry());
	mesh.add(bones[0]);
	mesh.bind(new Skeleton(bones));
	root.add(mesh);
	return root;
}

function makeClip(name, duration = 1) {
	const q = new QuaternionKeyframeTrack('Hips.quaternion', [0, duration], [0, 0, 0, 1, 0, 0, 0, 1]);
	const spine = new QuaternionKeyframeTrack('Spine.quaternion', [0, duration], [0, 0, 0, 1, 0, 0, 0, 1]);
	const arm = new QuaternionKeyframeTrack('LeftArm.quaternion', [0, duration], [0, 0, 0, 1, 0, 0, 0, 1]);
	const pos = new VectorKeyframeTrack('Hips.position', [0, duration], [0, 1, 0, 0, 1, 0]);
	return new AnimationClip(name, duration, [q, spine, arm, pos]);
}

/** A manager pre-loaded with the named clips, attached to a fresh rig. */
function makeManager(names) {
	const am = new AnimationManager();
	for (const n of names) am.clips.set(n, makeClip(n));
	am.attach(makeRig());
	return am;
}

describe('AnimationManager.playOnce', () => {
	it('plays a one-shot as LoopOnce + clampWhenFinished and makes it current', async () => {
		const am = makeManager(['wave', 'idle']);
		await am.playOnce('wave', { settleTo: 'idle', fade: 0 });

		const action = am.actions.get('wave');
		expect(action).toBeTruthy();
		expect(am.currentName).toBe('wave');
		expect(am.currentAction).toBe(action);
		expect(action.loop).toBe(LoopOnce);
		expect(action.clampWhenFinished).toBe(true);
		expect(action.isRunning()).toBe(true);
	});

	it('settles into idle (a loop) once the one-shot finishes', async () => {
		const am = makeManager(['wave', 'idle']);
		await am.playOnce('wave', { settleTo: 'idle', fade: 0 });

		// Tick the mixer past the 1s clip so the 'finished' event fires.
		am.update(0.6);
		am.update(0.6);
		// crossfadeTo in the finished handler is async (ensureLoaded) — flush it.
		await new Promise((r) => setTimeout(r, 0));

		expect(am.currentName).toBe('idle');
		const idle = am.actions.get('idle');
		expect(am.currentAction).toBe(idle);
		expect(idle.loop).toBe(LoopRepeat);
	});

	it('falls back to the settle clip when the one-shot is unavailable on the rig', async () => {
		const am = makeManager(['idle']);
		await am.playOnce('does-not-exist', { settleTo: 'idle', fade: 0 });
		// Never leaves the avatar frozen in bind pose — settles to idle instead.
		expect(am.currentName).toBe('idle');
		expect(am.currentAction).toBe(am.actions.get('idle'));
	});

	it('does nothing (no throw) when neither the clip nor a settle clip exist', async () => {
		const am = makeManager(['idle']);
		await expect(am.playOnce('missing', { settleTo: null })).resolves.toBeUndefined();
		expect(am.currentName).toBeNull();
	});
});

describe('AnimationManager.freeze', () => {
	it('pauses the active action and releases it so the render loop can idle', async () => {
		const am = makeManager(['idle']);
		await am.crossfadeTo('idle', 0);
		const idle = am.actions.get('idle');
		expect(am.currentAction).toBe(idle);

		am.freeze();
		expect(idle.paused).toBe(true);
		expect(am.currentAction).toBeNull();
		expect(am.currentName).toBeNull();
	});

	it('is a no-op when nothing is playing', () => {
		const am = makeManager(['idle']);
		expect(() => am.freeze()).not.toThrow();
		expect(am.currentAction).toBeNull();
	});
});

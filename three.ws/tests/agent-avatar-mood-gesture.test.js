/**
 * AgentAvatar × sustained mood → gesture-slot bias — unit tests.
 *
 * Exercises Stage 3.5 of `_tickEmotion()`: the sustained mood layer (valence ×
 * arousal, set via `setMood()`) biasing which gesture *slot* the avatar plays,
 * on top of the pre-existing transient-emotion gesture triggers (Stage 3) and
 * the facial/postural mood layer (`_applyMoodLayer`). No Three.js render loop
 * or real animation clips are needed — `_tickEmotion()` is called directly
 * against a minimal fake viewer, mirroring the approach in
 * tests/agent-avatar-lipsync.test.js.
 */

import { describe, it, expect, beforeEach } from 'vitest';

let AgentAvatar;

// ── Fakes ────────────────────────────────────────────────────────────────────

// Object3D-shaped root with a no-op traverse — enough for `_findHeadBone()`
// and `_trackBodyToCamera()` to no-op safely without a real skeleton.
function makeRoot() {
	return {
		isObject3D: true,
		children: [],
		traverse(fn) {
			fn(this);
		},
	};
}

/**
 * Fake AnimationManager. `loadedNames` is the whitelist of clip names that
 * "exist" on this rig (isLoaded → true); everything else is unregistered.
 * Records every clip name actually handed to play()/crossfadeTo() so tests
 * can assert the gesture bias never reaches for a name outside the whitelist.
 */
function makeFakeAnimationManager(loadedNames = []) {
	const loaded = new Set(loadedNames);
	const played = [];
	return {
		currentName: null,
		isLoaded: (name) => loaded.has(name),
		getAnimationDefs: () => [],
		play: (name) => {
			played.push(name);
			return Promise.resolve(true);
		},
		crossfadeTo: (name) => {
			played.push(name);
		},
		played,
	};
}

function makeFakeViewer(am) {
	return {
		content: makeRoot(),
		animationManager: am,
		state: {},
	};
}

function makeAvatar(am) {
	const viewer = makeFakeViewer(am);
	const protocol = {}; // unused outside attach()
	const identity = { id: 'test' };
	return new AgentAvatar(viewer, protocol, identity);
}

// Ticks with a large dt so `_moodApplied` (lerp factor `dt * 1.2`, clamped to
// 1) fully converges to the mood target within a single tick, and a second
// tick is enough for Stage 3.5 (which reads the *previous* frame's applied
// mood, since it runs before Stage 4's lerp) to see the converged value.
function settleMood(avatar, times = 3) {
	for (let i = 0; i < times; i++) avatar._tickEmotion(1);
}

beforeEach(async () => {
	if (!AgentAvatar) {
		const mod = await import('../src/agent-avatar.js');
		AgentAvatar = mod.AgentAvatar;
	}
});

describe('AgentAvatar — sustained mood → gesture-slot bias', () => {
	it('a sustained high-arousal-positive mood biases toward the energetic (celebrate) gesture', () => {
		const am = makeFakeAnimationManager(['celebrate', 'defeated']);
		const avatar = makeAvatar(am);

		avatar.setMood(0.6, 0.8); // clearly up + energetic
		settleMood(avatar);

		expect(am.played).toContain('celebrate');
		expect(am.played).not.toContain('defeated');
	});

	it('a sustained low-arousal-negative mood biases away from the energetic gesture', () => {
		const am = makeFakeAnimationManager(['celebrate', 'defeated']);
		const avatar = makeAvatar(am);

		avatar.setMood(-0.6, 0.1); // clearly down + subdued
		settleMood(avatar);

		expect(am.played).not.toContain('celebrate');
		// The concern slot resolves to the "defeated" library clip by default —
		// confirms the bias picked the opposite-valence gesture, not silence.
		expect(am.played).toContain('defeated');
	});

	it('a neutral resting mood (defaults, setMood never called) triggers no gesture bias', () => {
		const am = makeFakeAnimationManager(['celebrate', 'defeated']);
		const avatar = makeAvatar(am);

		settleMood(avatar); // _mood.active stays false — no setMood() call

		expect(am.played).toEqual([]);
	});

	it('never selects a clip that is not registered on the attached rig', () => {
		// Nothing is loaded and no defs are registered — every slot resolves to
		// an unregistered clip name. The bias must not hand an unknown name to
		// play()/crossfadeTo(); it degrades to the embedded-clip fallback (a
		// silent no-op here, since the fake viewer has no `mixer`/`clips`).
		const am = makeFakeAnimationManager([]);
		const avatar = makeAvatar(am);

		avatar.setMood(0.9, 0.95); // maximally energetic + positive
		expect(() => settleMood(avatar)).not.toThrow();

		expect(am.played).toEqual([]);
	});

	it('composes with meta.edits.animations — an overridden celebrate slot plays the custom clip', () => {
		const am = makeFakeAnimationManager(['victory-dance-custom']);
		const avatar = makeAvatar(am);
		avatar.setAnimationMap({ celebrate: 'victory-dance-custom' });

		avatar.setMood(0.6, 0.8);
		settleMood(avatar);

		expect(am.played).toContain('victory-dance-custom');
		expect(am.played).not.toContain('celebrate');
	});

	it('a live transient emotion spike still takes priority over the sustained mood bias', () => {
		const am = makeFakeAnimationManager(['celebrate', 'defeated']);
		const avatar = makeAvatar(am);

		// Sustained mood says "down + subdued" (would bias toward `concern`)...
		avatar.setMood(-0.6, 0.1);
		// ...but a momentary celebration spike (e.g. a skill just succeeded) is
		// injected via the public emote path, well above the Stage-3 threshold.
		avatar._injectStimulus('celebration', 0.9);

		// Only 2 ticks: the transient spike decays below the 0.6 threshold after
		// ~2s (DECAY.celebration = 0.18/s), at which point Stage 3 correctly
		// falls through to the sustained mood bias below it — that hand-off is
		// the intended behaviour, not something this test covers. Within the
		// window the spike is still live, mood must not preempt it.
		settleMood(avatar, 2);

		expect(am.played).toContain('celebrate');
		expect(am.played).not.toContain('defeated');
	});
});

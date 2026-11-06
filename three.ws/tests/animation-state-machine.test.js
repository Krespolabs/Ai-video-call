/**
 * AnimationStateMachine — unit tests.
 *
 * The machine is pure (no Three.js); we stub `onTransition` to capture the
 * playback intents it would have issued and assert on those.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	AnimationStateMachine,
	DEFAULT_STATES,
	DEFAULT_TRANSITIONS,
	STATE_NAMES,
	GESTURES,
	GESTURE_NAMES,
} from '../src/animation-state-machine.js';

function record() {
	const calls = [];
	const fn = (payload) => calls.push(payload);
	fn.calls = calls;
	return fn;
}

describe('AnimationStateMachine — defaults', () => {
	let onT, sm;
	beforeEach(() => {
		onT = record();
		sm = new AnimationStateMachine({}, onT);
	});

	it('exposes the canonical state list', () => {
		expect(STATE_NAMES).toEqual(['idle', 'talk', 'walk', 'react', 'emote', 'listen', 'think']);
		for (const n of STATE_NAMES) expect(DEFAULT_STATES[n]?.clip).toBeTruthy();
	});

	it('listen / think are looping postures that leave back to idle', () => {
		expect(sm.fire('listen')).toBe('listen');
		expect(DEFAULT_STATES.listen.loop).toBe(true);
		expect(DEFAULT_STATES.listen.oneShot).toBe(false);
		expect(sm.fire('listen-end')).toBe('idle');
		expect(sm.fire('think')).toBe('think');
		expect(DEFAULT_STATES.think.loop).toBe(true);
		expect(sm.fire('think-end')).toBe('idle');
		expect(DEFAULT_TRANSITIONS.listen).toBe('listen');
		expect(DEFAULT_TRANSITIONS.think).toBe('think');
	});

	it('starts in idle', () => {
		expect(sm.getCurrent()).toBe('idle');
		expect(sm.getCurrentClip()).toBe('idle');
	});

	it('speak → talk → speak-end → idle', () => {
		expect(sm.fire('speak')).toBe('talk');
		expect(sm.getCurrent()).toBe('talk');
		expect(sm.fire('speak-end')).toBe('idle');
		expect(onT.calls.map((c) => c.state)).toEqual(['talk', 'idle']);
		// Default talk clip falls back to idle — lip-sync handles the mouth.
		expect(onT.calls[0].clip).toBe('idle');
		expect(onT.calls[1].clip).toBe('idle');
	});

	it('walk ↔ idle round-trip with crossfade payload', () => {
		expect(sm.fire('walk')).toBe('walk');
		expect(onT.calls[0]).toMatchObject({ state: 'walk', clip: 'walk' });
		expect(onT.calls[0].crossfade).toBeGreaterThan(0);
		expect(onT.calls[0].crossfade).toBeLessThanOrEqual(5);
		sm.fire('walk-end');
		expect(sm.getCurrent()).toBe('idle');
	});

	it('a one-shot fired during talk returns to talk on react-end (not idle)', () => {
		sm.fire('speak');                       // idle → talk
		expect(sm.fire('react')).toBe('react'); // talk → react
		expect(sm.fire('react-end')).toBe('talk');
	});

	it('a one-shot fired during walk returns to walk on emote-end', () => {
		sm.fire('walk');
		sm.fire('emote');
		expect(sm.fire('emote-end')).toBe('walk');
	});

	it('two stacked one-shots unwind in LIFO order', () => {
		sm.fire('speak'); // → talk
		sm.fire('react'); // → react (stack: [talk])
		sm.fire('emote'); // → emote (stack: [talk])
		// `emote-end` pops `talk`, NOT `react` — the machine never re-enters one-shots.
		expect(sm.fire('emote-end')).toBe('talk');
		expect(sm.fire('speak-end')).toBe('idle');
	});

	it('back-to-back identical fires are idempotent (no spurious transition)', () => {
		sm.fire('walk');
		const seen = onT.calls.length;
		expect(sm.fire('walk')).toBe('walk');
		expect(onT.calls.length).toBe(seen);
	});

	it('unknown event returns null and does not fire onTransition', () => {
		expect(sm.fire('jiggle')).toBeNull();
		expect(onT.calls.length).toBe(0);
	});

	it('null/empty/non-string events return null', () => {
		expect(sm.fire(null)).toBeNull();
		expect(sm.fire('')).toBeNull();
		expect(sm.fire(42)).toBeNull();
	});

	it('reset() clears the return stack and goes back to initial', () => {
		sm.fire('speak');
		sm.fire('react');
		sm.reset();
		expect(sm.getCurrent()).toBe('idle');
		// After reset, react-end has nothing to pop — stays at idle.
		expect(sm.fire('react-end')).toBe('idle');
	});

	it('onTransition errors do not crash the machine', () => {
		const noisy = new AnimationStateMachine({}, () => { throw new Error('boom'); });
		expect(() => noisy.fire('speak')).not.toThrow();
		expect(noisy.getCurrent()).toBe('talk');
	});
});

describe('AnimationStateMachine — custom graph', () => {
	it('respects per-state clip overrides', () => {
		const sm = new AnimationStateMachine(
			{ states: { idle: { clip: 'breathing' }, talk: { clip: 'speech_animated' } } },
			null,
		);
		expect(sm.getCurrentClip()).toBe('breathing');
		sm.fire('speak');
		expect(sm.getCurrentClip()).toBe('speech_animated');
	});

	it('clamps crossfade to [0, 5]', () => {
		const sm = new AnimationStateMachine({
			states: { idle: { crossfade: -1 }, talk: { crossfade: 99 } },
		});
		expect(sm.states.idle.crossfade).toBe(0);
		expect(sm.states.talk.crossfade).toBe(5);
	});

	it('respects a custom event → state transition', () => {
		const onT = record();
		const sm = new AnimationStateMachine(
			{ transitions: { 'sit': 'idle', 'jump': 'emote' } },
			onT,
		);
		sm.fire('sit');
		expect(sm.getCurrent()).toBe('idle');
		sm.fire('jump');
		expect(sm.getCurrent()).toBe('emote');
	});

	it('starts in a custom initial state when valid', () => {
		const sm = new AnimationStateMachine({ initial: 'walk' });
		expect(sm.getCurrent()).toBe('walk');
	});

	it('ignores an invalid initial state and falls back to idle', () => {
		const sm = new AnimationStateMachine({ initial: 'nonexistent' });
		expect(sm.getCurrent()).toBe('idle');
	});

	it('supports user-defined extra states (e.g. dance)', () => {
		const sm = new AnimationStateMachine({
			states: { dance: { clip: 'hiphop', loop: true, oneShot: false } },
			transitions: { 'party': 'dance', 'party-end': 'idle' },
		});
		expect(sm.fire('party')).toBe('dance');
		expect(sm.getCurrentClip()).toBe('hiphop');
		expect(sm.fire('party-end')).toBe('idle');
	});

	it('does not store user state overrides with invalid types', () => {
		const sm = new AnimationStateMachine({
			states: {
				idle: { clip: 123 /* not a string */ },
				talk: { loop: 'yes' /* not a boolean */ },
			},
		});
		// Invalid values are ignored; defaults remain.
		expect(sm.states.idle.clip).toBe(DEFAULT_STATES.idle.clip);
		expect(sm.states.talk.loop).toBe(DEFAULT_STATES.talk.loop);
	});
});

describe('AnimationStateMachine — onTransition payload', () => {
	it('payload contains state, def, clip, crossfade', () => {
		const onT = record();
		const sm = new AnimationStateMachine({}, onT);
		sm.fire('walk');
		const p = onT.calls[0];
		expect(p.state).toBe('walk');
		expect(p.clip).toBe('walk');
		expect(p.def).toBe(sm.states.walk);
		expect(typeof p.crossfade).toBe('number');
	});
});

describe('AnimationStateMachine — gesture slot', () => {
	let onT, onG, sm;
	beforeEach(() => {
		onT = record();
		onG = record();
		sm = new AnimationStateMachine({}, onT, onG);
	});

	it('exposes the built-in gestures', () => {
		expect(GESTURE_NAMES).toEqual([
			'wave', 'dance', 'sit', 'point', 'cheer', 'agree', 'disagree', 'talking',
			'nod', 'shrug', 'jog', 'celebrate',
		]);
		for (const name of GESTURE_NAMES) {
			const g = GESTURES[name];
			expect(typeof g.clip).toBe('string');
			expect(['upper', 'full']).toContain(g.layer);
			expect(typeof g.crossfade).toBe('number');
		}
	});

	it('playGesture sets the slot and fires onGesture with the resolved def', () => {
		const out = sm.playGesture('wave');
		expect(out).toBe('wave');
		expect(sm.getGesture()).toBe('wave');
		const p = onG.calls[0];
		expect(p.active).toBe(true);
		expect(p.gesture).toBe('wave');
		expect(p.def.clip).toBe('wave');
		expect(p.def.layer).toBe('upper');
		expect(p.prev).toBe(null);
	});

	it('rejects unknown gestures without touching the slot', () => {
		expect(sm.playGesture('moonwalk')).toBe(null);
		expect(sm.getGesture()).toBe(null);
		expect(onG.calls.length).toBe(0);
	});

	it('re-firing the active gesture is a no-op (held loops do not restart)', () => {
		sm.playGesture('dance');
		sm.playGesture('dance');
		expect(onG.calls.length).toBe(1);
		expect(sm.getGesture()).toBe('dance');
	});

	it('switching gestures reports the previous one', () => {
		sm.playGesture('wave');
		sm.playGesture('cheer');
		expect(sm.getGesture()).toBe('cheer');
		expect(onG.calls[1].prev).toBe('wave');
	});

	it('endGesture clears the slot and fires active:false', () => {
		sm.playGesture('sit');
		const cleared = sm.endGesture();
		expect(cleared).toBe('sit');
		expect(sm.getGesture()).toBe(null);
		const p = onG.calls[onG.calls.length - 1];
		expect(p.active).toBe(false);
		expect(p.gesture).toBe(null);
		expect(p.prev).toBe('sit');
	});

	it('endGesture with no active gesture is a no-op', () => {
		expect(sm.endGesture()).toBe(null);
		expect(onG.calls.length).toBe(0);
	});

	it('runs the gesture slot in parallel to the base state', () => {
		sm.fire('walk');
		sm.playGesture('wave');
		// Base locomotion is untouched by the gesture slot.
		expect(sm.getCurrent()).toBe('walk');
		expect(sm.getGesture()).toBe('wave');
	});

	it('reset clears both the base state and the gesture slot', () => {
		sm.fire('walk');
		sm.playGesture('dance');
		sm.reset();
		expect(sm.getCurrent()).toBe('idle');
		expect(sm.getGesture()).toBe(null);
	});
});

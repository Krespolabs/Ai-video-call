import { describe, it, expect } from 'vitest';
import {
	BASELINE,
	DEFAULT_SENSITIVITY,
	SIGNALS,
	MOODS,
	moodLabel,
	makeState,
	applySignal,
	decay,
	moodDistance,
	signalFromSentiment,
	clampSensitivity,
} from '../src/agents/mood-model.js';

describe('mood-model', () => {
	it('starts at a calm, mildly-positive baseline', () => {
		const s = makeState();
		expect(s.valence).toBeCloseTo(BASELINE.valence);
		expect(s.arousal).toBeCloseTo(BASELINE.arousal);
		expect(moodLabel(s.valence, s.arousal).key).toBe('calm');
	});

	it('projects the circumplex into the documented discrete octants', () => {
		expect(moodLabel(0.6, 0.8).key).toBe('elated');
		expect(moodLabel(0.6, 0.3).key).toBe('content');
		expect(moodLabel(-0.6, 0.8).key).toBe('agitated');
		expect(moodLabel(-0.6, 0.3).key).toBe('subdued');
		expect(moodLabel(0.0, 0.8).key).toBe('alert');
		expect(moodLabel(0.0, 0.2).key).toBe('calm');
	});

	it('every mood declares a real embodiment trigger + emoji + colour', () => {
		const triggers = new Set(['celebration', 'concern', 'curiosity', 'empathy', 'patience', 'uncertain']);
		for (const m of MOODS) {
			expect(triggers.has(m.trigger)).toBe(true);
			expect(m.emoji.length).toBeGreaterThan(0);
			expect(m.color).toMatch(/^#[0-9a-f]{6}$/i);
			expect(m.intensity).toBeGreaterThan(0);
		}
	});

	it('applies a known signal scaled by sensitivity and weight', () => {
		const s = makeState();
		const after = applySignal(s, 'action:success', { sensitivity: 1, weight: 1 });
		expect(after.valence).toBeGreaterThan(s.valence);
		expect(after.arousal).toBeGreaterThan(s.arousal);
		// The dv/da come straight from the catalogue at full gain.
		expect(after.valence).toBeCloseTo(BASELINE.valence + SIGNALS['action:success'].dv);
	});

	it('a stoic agent (sensitivity 0) never leaves baseline', () => {
		const s = makeState();
		const after = applySignal(s, 'alert:bad', { sensitivity: 0 });
		expect(after.valence).toBeCloseTo(s.valence);
		expect(after.arousal).toBeCloseTo(s.arousal);
	});

	it('accepts an explicit {dv,da} delta as well as a catalogue key', () => {
		const s = makeState();
		const after = applySignal(s, { dv: -0.2, da: 0.1 }, { sensitivity: 1 });
		expect(after.valence).toBeLessThan(s.valence);
		expect(after.arousal).toBeGreaterThan(s.arousal);
	});

	it('ignores an unknown signal key (no movement)', () => {
		const s = { valence: 0.5, arousal: 0.5 };
		const after = applySignal(s, 'nope:nope', { sensitivity: 1 });
		expect(after).toEqual(s);
	});

	it('clamps valence to [-1,1] and arousal to [0,1] under repeated signals', () => {
		let s = makeState();
		for (let i = 0; i < 50; i++) s = applySignal(s, 'alert:good', { sensitivity: 1 });
		expect(s.valence).toBeLessThanOrEqual(1);
		expect(s.arousal).toBeLessThanOrEqual(1);
		let t = makeState();
		for (let i = 0; i < 50; i++) t = applySignal(t, 'action:failure', { sensitivity: 1 });
		expect(t.valence).toBeGreaterThanOrEqual(-1);
		expect(t.arousal).toBeLessThanOrEqual(1);
	});

	it('decays toward baseline and is frame-rate independent', () => {
		const spiked = { valence: 0.9, arousal: 0.9 };
		const oneStep = decay(spiked, 60_000);
		// Many small steps over the same elapsed time land in the same place.
		let many = spiked;
		for (let i = 0; i < 600; i++) many = decay(many, 100);
		expect(many.valence).toBeCloseTo(oneStep.valence, 3);
		expect(many.arousal).toBeCloseTo(oneStep.arousal, 3);
		// And it moved toward baseline, not past it.
		expect(oneStep.valence).toBeLessThan(spiked.valence);
		expect(oneStep.valence).toBeGreaterThan(BASELINE.valence);
		expect(oneStep.arousal).toBeLessThan(spiked.arousal);
	});

	it('decay eventually settles to baseline', () => {
		let s = { valence: -0.8, arousal: 0.95 };
		for (let i = 0; i < 100; i++) s = decay(s, 60_000);
		expect(s.valence).toBeCloseTo(BASELINE.valence, 2);
		expect(s.arousal).toBeCloseTo(BASELINE.arousal, 2);
	});

	it('arousal decays faster than valence (lingering mood)', () => {
		const spiked = { valence: 0.9, arousal: 0.9 };
		const d = decay(spiked, 70_000);
		const valenceDrop = spiked.valence - d.valence;
		const arousalDrop = spiked.arousal - d.arousal;
		expect(arousalDrop).toBeGreaterThan(valenceDrop);
	});

	it('derives a sentiment signal only from a non-neutral score', () => {
		expect(signalFromSentiment(0)).toBeNull();
		expect(signalFromSentiment(0.02)).toBeNull();
		const pos = signalFromSentiment(0.5);
		expect(pos.signal).toBe('chat:positive');
		expect(pos.weight).toBeGreaterThan(0);
		const neg = signalFromSentiment(-0.5);
		expect(neg.signal).toBe('chat:negative');
	});

	it('moodDistance is symmetric and zero for identical points', () => {
		const a = { valence: 0.2, arousal: 0.4 };
		const b = { valence: -0.3, arousal: 0.7 };
		expect(moodDistance(a, a)).toBe(0);
		expect(moodDistance(a, b)).toBeCloseTo(moodDistance(b, a));
		expect(moodDistance(a, b)).toBeGreaterThan(0);
	});

	it('clampSensitivity falls back to the default for garbage', () => {
		expect(clampSensitivity(NaN)).toBe(DEFAULT_SENSITIVITY);
		expect(clampSensitivity(2)).toBe(1);
		expect(clampSensitivity(-1)).toBe(0);
		expect(clampSensitivity(0.4)).toBe(0.4);
	});
});

/**
 * Text-timed lip-sync envelope — deterministic, bounded, and honest about its
 * words (vowels open the mouth, bilabials close it, length tracks the text).
 */

import { describe, it, expect } from 'vitest';
import { estimateSpeechDuration, TextVisemeEnvelope } from '../src/embodiment/text-visemes.js';

describe('estimateSpeechDuration', () => {
	it('grows with word count and clamps to [min,max]', () => {
		const short = estimateSpeechDuration('hi');
		const long = estimateSpeechDuration('word '.repeat(80));
		expect(long).toBeGreaterThan(short);
		expect(estimateSpeechDuration('')).toBeGreaterThanOrEqual(0.6);
		expect(estimateSpeechDuration('word '.repeat(10000))).toBeLessThanOrEqual(40);
	});
});

describe('TextVisemeEnvelope', () => {
	it('is deterministic — same text + rate yields the same motion', () => {
		const a = new TextVisemeEnvelope('hello there', { wpm: 165 });
		const b = new TextVisemeEnvelope('hello there', { wpm: 165 });
		for (const t of [0, 0.1, 0.3, 0.6]) {
			expect(a.sample(t)).toEqual(b.sample(t));
		}
	});

	it('keeps every channel within [0,1] and eases shut past the end', () => {
		const env = new TextVisemeEnvelope('aeiou bmp', { wpm: 165 });
		for (let t = 0; t <= env.duration + 1; t += env.duration / 7) {
			const s = env.sample(t);
			for (const k of ['open', 'wide', 'round']) {
				expect(s[k]).toBeGreaterThanOrEqual(0);
				expect(s[k]).toBeLessThanOrEqual(1);
			}
		}
		expect(env.done(env.duration + 0.5)).toBe(true);
		// Well past the end the mouth has eased toward rest.
		let last = { open: 1 };
		const fresh = new TextVisemeEnvelope('aeiou bmp', { wpm: 165 });
		for (let i = 0; i < 50; i++) last = fresh.sample(fresh.duration + 2);
		expect(last.open).toBeLessThan(0.05);
	});

	it('opens wider on a vowel-heavy line than a consonant-heavy one', () => {
		const peak = (text) => {
			const env = new TextVisemeEnvelope(text, { wpm: 165 });
			let max = 0;
			for (let t = 0; t < env.duration; t += env.duration / 40) max = Math.max(max, env.sample(t).open);
			return max;
		};
		expect(peak('aaaaaa')).toBeGreaterThan(peak('mbpmbp'));
	});

	it('handles empty text without throwing', () => {
		const env = new TextVisemeEnvelope('', {});
		expect(env.sample(0)).toBeTypeOf('object');
		expect(env.done(env.duration + 1)).toBe(true);
	});
});

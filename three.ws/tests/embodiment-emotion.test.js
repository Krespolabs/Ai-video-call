/**
 * Embodiment emotion classifier + the manifest contract emotion.js promises.
 *
 * emotion.js says every gesture/idle clip it can ask for "MUST exist in
 * public/animations/manifest.json — see the test." This is that test. It also
 * pins the gesture clips the state machine added, so a future clip rename can't
 * silently break either mapping.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	EMOTIONS,
	detectEmotion,
	expressionFor,
	expressionForText,
	referencedClipNames,
} from '../src/embodiment/emotion.js';
import { GESTURES } from '../src/animation-state-machine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
	readFileSync(resolve(__dirname, '../public/animations/manifest.json'), 'utf8'),
);
const CLIP_NAMES = new Set(manifest.map((c) => c.name));

describe('detectEmotion', () => {
	it('returns neutral with zero intensity for empty / signal-free text', () => {
		for (const t of ['', null, undefined, 'the cat sat on the mat']) {
			const r = detectEmotion(t);
			expect(r.emotion).toBe('neutral');
			expect(r.intensity).toBe(0);
		}
	});

	it('classifies the obvious emotions from lexical cues', () => {
		expect(detectEmotion('Congratulations, that is amazing! 🎉').emotion).toBe('joy');
		expect(detectEmotion("I'm so sorry, unfortunately that failed").emotion).toBe('sad');
		expect(detectEmotion('This is unacceptable and frustrating').emotion).toBe('angry');
		expect(detectEmotion('Whoa, no way — that is incredible!').emotion).toBe('surprised');
		expect(detectEmotion('Hmm, let me think and analyze this').emotion).toBe('thinking');
	});

	it('intensity rises with shouting and stays within [0,1]', () => {
		const calm = detectEmotion('that is great');
		const loud = detectEmotion('THAT IS GREAT!!!');
		expect(loud.intensity).toBeGreaterThan(calm.intensity);
		expect(loud.intensity).toBeLessThanOrEqual(1);
		expect(calm.intensity).toBeGreaterThanOrEqual(0);
	});
});

describe('expressionFor', () => {
	it('scales the face weights by intensity and clamps emotion to the known set', () => {
		const full = expressionFor('joy', 1);
		const half = expressionFor('joy', 0.5);
		expect(full.face.mouthSmileLeft).toBeGreaterThan(half.face.mouthSmileLeft);
		expect(expressionFor('not-an-emotion', 1).emotion).toBe('neutral');
	});

	it('escalates to the high-intensity gesture past the threshold', () => {
		expect(expressionFor('joy', 0.4).gesture).toBe('av-joy');
		expect(expressionFor('joy', 0.9).gesture).toBe('av-celebrating');
	});

	it('every emotion yields a renderable descriptor', () => {
		for (const emo of EMOTIONS) {
			const d = expressionFor(emo, 1);
			expect(d.emotion).toBe(emo);
			expect(typeof d.idle).toBe('string');
			expect(d.face).toBeTypeOf('object');
		}
	});
});

describe('expressionForText', () => {
	it('threads classification through to a full descriptor', () => {
		const d = expressionForText('Congrats! 🎉 amazing work');
		expect(d.emotion).toBe('joy');
		expect(d.gesture).toBeTruthy();
		expect(d.scores).toBeTypeOf('object');
	});
});

describe('animation manifest contract', () => {
	it('every clip emotion.js can request exists in the manifest', () => {
		for (const name of referencedClipNames()) {
			expect(CLIP_NAMES.has(name), `emotion clip "${name}" missing from manifest`).toBe(true);
		}
	});

	it('every gesture clip the state machine exposes exists in the manifest', () => {
		// `sitidle` was a known pre-existing gap (registry known_issues:
		// broken-fidget-slot's sibling) — build-animations.mjs now merges it in
		// from animations-extra-clips.json, so every declared gesture is covered.
		for (const g of Object.keys(GESTURES)) {
			const clip = GESTURES[g]?.clip;
			expect(clip, `gesture "${g}" has no clip`).toBeTruthy();
			expect(CLIP_NAMES.has(clip), `gesture "${g}" → "${clip}" missing from manifest`).toBe(true);
		}
	});
});

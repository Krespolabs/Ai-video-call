// Diversity engine for the photo-seeded Avaturn lane (api/_lib/avaturn-seed.js).
// These pin the contract that makes the seeded gallery read as genuinely
// different people: a deterministic draw across a broad gender/age/ethnicity/
// build matrix, on-model face prompts, and a clean human-readable label.

import { describe, it, expect } from 'vitest';
import {
	pickDiversityProfile,
	faceGenPrompts,
	describeProfile,
	AGE_BANDS,
	ETHNICITIES,
	BUILDS,
} from '../api/_lib/avaturn-seed.js';

describe('pickDiversityProfile', () => {
	it('is deterministic for a given seed', () => {
		const a = pickDiversityProfile('seed-123');
		const b = pickDiversityProfile('seed-123');
		expect(a).toEqual(b);
	});

	it('varies across seeds', () => {
		const keys = new Set();
		for (let i = 0; i < 40; i++) {
			const p = pickDiversityProfile(`s${i}`);
			keys.add(`${p.gender}|${p.ageKey}|${p.ethnicityKey}|${p.build}`);
		}
		// A broad matrix should yield many distinct combinations over 40 draws.
		expect(keys.size).toBeGreaterThan(20);
	});

	it('covers both genders, every age band and ethnicity over enough seeds', () => {
		const genders = new Set();
		const ages = new Set();
		const eth = new Set();
		for (let i = 0; i < 300; i++) {
			const p = pickDiversityProfile(`cover-${i}`);
			genders.add(p.gender);
			ages.add(p.ageKey);
			eth.add(p.ethnicityKey);
		}
		expect(genders).toEqual(new Set(['male', 'female']));
		expect(ages.size).toBe(AGE_BANDS.length);
		expect(eth.size).toBe(ETHNICITIES.length);
	});

	it('keeps skin-tone correction inside the ethnicity band', () => {
		for (let i = 0; i < 200; i++) {
			const p = pickDiversityProfile(`skin-${i}`);
			const band = ETHNICITIES.find((e) => e.key === p.ethnicityKey);
			expect(p.skinToneCorrection).toBeGreaterThanOrEqual(band.skin[0]);
			expect(p.skinToneCorrection).toBeLessThanOrEqual(band.skin[1]);
		}
	});

	it('draws a valid build', () => {
		expect(BUILDS).toContain(pickDiversityProfile('b').build);
	});
});

describe('faceGenPrompts', () => {
	it('produces three distinct on-model views carrying the profile descriptors', () => {
		const profile = pickDiversityProfile('face-seed');
		const p = faceGenPrompts(profile);
		const noun = profile.gender === 'male' ? 'man' : 'woman';
		for (const view of [p.frontal, p.left, p.right]) {
			expect(view).toContain(profile.ethnicityDesc);
			expect(view).toContain(noun);
			expect(view).toContain('plain light-grey seamless background');
		}
		expect(p.frontal).not.toEqual(p.left);
		expect(p.left).not.toEqual(p.right);
		expect(p.left).toMatch(/left/);
		expect(p.right).toMatch(/right/);
	});
});

describe('describeProfile', () => {
	it('reads as a short human label without the wrinkle clause', () => {
		const label = describeProfile({
			gender: 'female',
			ageDesc: 'in their late sixties, natural wrinkles and gentle age lines',
			ethnicityDesc: 'East Asian',
		});
		expect(label).toBe('East Asian woman, in their late sixties');
		expect(label).not.toMatch(/wrinkles/);
	});
});

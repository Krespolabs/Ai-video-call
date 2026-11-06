/**
 * Gallery category classifier — unit tests.
 *
 * The /animations gallery derives a category for every clip from its label
 * (the Mixamo catalog ships none). These tests pin the rule ordering that
 * makes labels file where a human would put them — "Zombie Walk" is creature,
 * not locomotion; "Rifle Run" is weapons — plus the curated-name passthrough
 * and full-coverage guarantees over the real staged library manifest when it
 * is present on disk.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { GALLERY_CATEGORIES, galleryCategoryOf } from '../src/animation-categories.js';

const KEYS = new Set(GALLERY_CATEGORIES.map((c) => c.key));

describe('galleryCategoryOf', () => {
	it('classifies representative labels where a human would file them', () => {
		expect(galleryCategoryOf('mx-x', 'Hip Hop Dancing')).toBe('dance');
		expect(galleryCategoryOf('mx-x', 'Walking')).toBe('locomotion');
		expect(galleryCategoryOf('mx-x', '135 Degree Left Turn')).toBe('locomotion');
		expect(galleryCategoryOf('mx-x', 'Idle')).toBe('idle');
		expect(galleryCategoryOf('mx-x', 'Boxing Jab Cross')).toBe('combat');
		expect(galleryCategoryOf('mx-x', 'Rifle Aiming Idle')).toBe('weapons');
		expect(galleryCategoryOf('mx-x', 'Great Sword Slash')).toBe('weapons');
		expect(galleryCategoryOf('mx-x', 'Soccer Penalty Kick')).toBe('sport');
		expect(galleryCategoryOf('mx-x', 'Back Flip To Uppercut')).toBe('acrobatics');
		expect(galleryCategoryOf('mx-x', 'Dying Backwards')).toBe('death');
		expect(galleryCategoryOf('mx-x', 'Sitting Idle')).toBe('sit');
		expect(galleryCategoryOf('mx-x', 'Push Up')).toBe('fitness');
		expect(galleryCategoryOf('mx-x', 'Waving Hello')).toBe('gesture');
		expect(galleryCategoryOf('mx-x', 'Reaction To Getting Clipped While Walking Unaware')).toBe(
			'reaction',
		);
	});

	it('orders rules so compound labels land in the dominant concept', () => {
		// creature beats locomotion
		expect(galleryCategoryOf('mx-x', 'Zombie Walking')).toBe('creature');
		// weapons beats locomotion
		expect(galleryCategoryOf('mx-x', 'Running With Rifle Down')).toBe('weapons');
		// dance beats locomotion
		expect(galleryCategoryOf('mx-x', 'Swing Dancing')).toBe('dance');
	});

	it('passes curated studio names through their hand-assigned category', () => {
		// From animation-presets.js CLIP_CATEGORIES — no keyword guessing.
		expect(galleryCategoryOf('av-boxer-dance', 'Boxer Dance')).toBe('dance');
		expect(galleryCategoryOf('idle', 'Idle')).toBe('idle');
		// Curated 'action' key maps onto the gallery's 'combat'.
		expect(galleryCategoryOf('av-muay-thai', 'Muay Thai')).toBe('combat');
	});

	it('falls back to "more" for labels no rule matches', () => {
		expect(galleryCategoryOf('mx-x', 'Xylophone Solo Nonsense')).toBe('more');
		expect(galleryCategoryOf('mx-x', '')).toBe('more');
		expect(galleryCategoryOf(undefined, undefined)).toBe('more');
	});

	it('always returns a declared category key', () => {
		const labels = ['Walk', 'Rifle Run', 'Salsa', '???', 'Casting A Spell', 'Zombie Scream'];
		for (const label of labels) {
			expect(KEYS.has(galleryCategoryOf('mx-x', label))).toBe(true);
		}
	});

	// Full-coverage guarantee over the real library, when the gitignored staged
	// manifest exists locally (CI checkouts without it skip this block).
	const STAGED = 'animation-sources/.library-clips/manifest.json';
	it.skipIf(!existsSync(STAGED))('covers the full staged library sanely', () => {
		const manifest = JSON.parse(readFileSync(STAGED, 'utf8'));
		const counts = new Map();
		for (const clip of manifest) {
			const key = galleryCategoryOf(clip.name, clip.label);
			expect(KEYS.has(key)).toBe(true);
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		// The catch-all must stay a tail, not a dumping ground.
		const more = counts.get('more') || 0;
		expect(more / manifest.length).toBeLessThan(0.1);
	});
});

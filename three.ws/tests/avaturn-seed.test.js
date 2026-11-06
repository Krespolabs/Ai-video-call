/**
 * avaturn-seed — unit tests for the pure look-randomization helpers and the
 * public-editor URL builder. The headless chromium export path is covered by
 * deployment smoke (it needs a real browser), so here we pin the deterministic,
 * I/O-free logic that decides *what* gets exported.
 */

import { describe, it, expect } from 'vitest';
import {
	hashSeed,
	mulberry32,
	pickOne,
	normalizeSlot,
	groupAssetsBySlot,
	pickRandomLook,
	pickBodyType,
	defaultEditorUrl,
	AVATURN_DEFAULT_BODY,
	WEARABLE_SLOTS,
	HAIR_COLORS,
	EYE_COLORS,
} from '../api/_lib/avaturn-seed.js';

const BODIES = [
	{ id: 'body-m1', gender: 'male' },
	{ id: 'body-m2', gender: 'male' },
	{ id: 'body-f1', gender: 'female' },
];

const ASSETS = [
	{ id: 'out-1', category: 'outfit' },
	{ id: 'out-2', category: 'clothing' }, // alias → outfit
	{ id: 'sho-1', category: 'footwear' }, // alias → shoes
	{ id: 'hair-1', category: 'hairstyle' }, // alias → hair
	{ id: 'hair-2', category: 'hair' },
	{ id: 'gls-1', category: 'eyewear' }, // alias → glasses
	{ id: 'hat-1', category: 'headwear' },
	{ id: 'misc-1', category: 'tattoo' }, // not a wearable slot — ignored
	{ id: 'bad' }, // no category, no id-less guard exercised elsewhere
];

describe('seeded RNG', () => {
	it('hashSeed is deterministic and unsigned 32-bit', () => {
		expect(hashSeed('hello')).toBe(hashSeed('hello'));
		expect(hashSeed('hello')).not.toBe(hashSeed('world'));
		expect(hashSeed('x')).toBeGreaterThanOrEqual(0);
		expect(hashSeed('x')).toBeLessThan(2 ** 32);
	});

	it('mulberry32 yields a reproducible stream in [0,1)', () => {
		const a = mulberry32(123);
		const b = mulberry32(123);
		for (let i = 0; i < 50; i++) {
			const v = a();
			expect(v).toBe(b());
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it('pickOne returns undefined for empty input', () => {
		expect(pickOne([], mulberry32(1))).toBeUndefined();
		expect(pickOne(null, mulberry32(1))).toBeUndefined();
	});
});

describe('slot normalization + grouping', () => {
	it('maps known aliases onto canonical slots', () => {
		expect(normalizeSlot('Clothing')).toBe('outfit');
		expect(normalizeSlot('FOOTWEAR')).toBe('shoes');
		expect(normalizeSlot('hairstyle')).toBe('hair');
		expect(normalizeSlot('eyewear')).toBe('glasses');
		expect(normalizeSlot('unknown')).toBe('unknown');
	});

	it('groups only wearable slots and drops id-less / non-wearable assets', () => {
		const grouped = groupAssetsBySlot(ASSETS);
		expect(grouped.outfit.map((a) => a.id).sort()).toEqual(['out-1', 'out-2']);
		expect(grouped.shoes.map((a) => a.id)).toEqual(['sho-1']);
		expect(grouped.hair.map((a) => a.id).sort()).toEqual(['hair-1', 'hair-2']);
		expect(grouped.glasses.map((a) => a.id)).toEqual(['gls-1']);
		expect(grouped.headwear.map((a) => a.id)).toEqual(['hat-1']);
		expect(grouped.tattoo).toBeUndefined();
		expect(grouped.bad).toBeUndefined();
	});
});

describe('pickRandomLook', () => {
	it('is deterministic for a given seed', () => {
		const a = pickRandomLook('seed-A', { bodies: BODIES, assets: ASSETS, bodyType: 'male' });
		const b = pickRandomLook('seed-A', { bodies: BODIES, assets: ASSETS, bodyType: 'male' });
		expect(a).toEqual(b);
	});

	it('respects the requested body type when bodies are tagged', () => {
		for (const seed of ['1', '2', '3', '4', '5']) {
			const look = pickRandomLook(seed, { bodies: BODIES, assets: ASSETS, bodyType: 'female' });
			expect(look.bodyId).toBe('body-f1');
		}
	});

	it('picks at most one asset per slot, all real ids', () => {
		const look = pickRandomLook('xyz', { bodies: BODIES, assets: ASSETS, bodyType: 'male' });
		const allIds = ASSETS.map((a) => a.id);
		for (const id of look.assetIds) expect(allIds).toContain(id);
		// No more picks than slots the catalog actually offers.
		expect(look.assetIds.length).toBeLessThanOrEqual(WEARABLE_SLOTS.length);
		// No duplicate ids.
		expect(new Set(look.assetIds).size).toBe(look.assetIds.length);
	});

	it('produces in-range colors + skin correction', () => {
		const look = pickRandomLook('color-seed', { bodies: BODIES, assets: ASSETS });
		expect(HAIR_COLORS).toContain(look.hairColor);
		expect(EYE_COLORS).toContain(look.eyeColor);
		expect(look.skinToneCorrection).toBeGreaterThanOrEqual(-15);
		expect(look.skinToneCorrection).toBeLessThanOrEqual(15);
	});

	it('falls back to the whole body pool when no gender match exists', () => {
		const untyped = [{ id: 'b1' }, { id: 'b2' }];
		const look = pickRandomLook('s', { bodies: untyped, assets: [], bodyType: 'female' });
		expect(['b1', 'b2']).toContain(look.bodyId);
		expect(look.assetIds).toEqual([]);
	});

	it('handles a totally empty catalog without throwing', () => {
		const look = pickRandomLook('s', { bodies: [], assets: [] });
		expect(look.bodyId).toBeNull();
		expect(look.assetIds).toEqual([]);
	});
});

describe('pickBodyType', () => {
	it('is deterministic and returns male|female', () => {
		expect(pickBodyType('abc')).toBe(pickBodyType('abc'));
		expect(['male', 'female']).toContain(pickBodyType('abc'));
	});

	it('produces a mix across seeds', () => {
		const types = new Set();
		for (let i = 0; i < 40; i++) types.add(pickBodyType('seed-' + i));
		expect(types).toEqual(new Set(['male', 'female']));
	});
});

describe('defaultEditorUrl (public demo editor — no API key)', () => {
	it('points at the public editor with the gender-appropriate default body', () => {
		const male = defaultEditorUrl('male');
		expect(male.startsWith('https://preview.avaturn.dev/editor?avatar_link=')).toBe(true);
		expect(decodeURIComponent(male.split('avatar_link=')[1])).toBe(AVATURN_DEFAULT_BODY.male);

		const female = defaultEditorUrl('female');
		expect(decodeURIComponent(female.split('avatar_link=')[1])).toBe(AVATURN_DEFAULT_BODY.female);
	});

	it('falls back to the male body for an unknown type', () => {
		const url = defaultEditorUrl('nonbinary-typo');
		expect(decodeURIComponent(url.split('avatar_link=')[1])).toBe(AVATURN_DEFAULT_BODY.male);
	});

	it('url-encodes the avatar_link so the editor parses it as one param', () => {
		const url = defaultEditorUrl('male');
		expect(url).toContain('avatar_link=https%3A%2F%2F');
		expect(new URL(url).searchParams.get('avatar_link')).toBe(AVATURN_DEFAULT_BODY.male);
	});
});

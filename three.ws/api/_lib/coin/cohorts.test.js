import { describe, it, expect } from 'vitest';
import { COHORTS, listCohorts, isCohortId, cohortSpec, sampleBucket, inSample } from './cohorts.js';

describe('cohort registry', () => {
	it('exposes a stable set of cohort ids', () => {
		expect(listCohorts().map((c) => c.id)).toEqual([
			'holders',
			'whales',
			'diamond-hands',
			'new-buyers',
			'exited',
		]);
	});

	it('every cohort declares name + description', () => {
		for (const c of COHORTS) {
			expect(c.name).toBeTruthy();
			expect(c.description).toBeTruthy();
			expect(Array.isArray(c.params)).toBe(true);
		}
	});

	it('isCohortId rejects unknown ids', () => {
		expect(isCohortId('whales')).toBe(true);
		expect(isCohortId('bogus')).toBe(false);
		expect(isCohortId('')).toBe(false);
	});
});

describe('cohortSpec bounds', () => {
	it('holders = any positive balance', () => {
		const s = cohortSpec('holders');
		expect(s.minBalance).toBe(1n);
		expect(s.maxBalance).toBe(null);
	});

	it('exited = exactly zero balance', () => {
		const s = cohortSpec('exited');
		expect(s.minBalance).toBe(0n);
		expect(s.maxBalance).toBe(0n);
	});

	it('whales clamps topPct into (0,1]', () => {
		expect(cohortSpec('whales', { topPct: 0.05 }).topPct).toBe(0.05);
		expect(cohortSpec('whales', { topPct: 5 }).topPct).toBe(1);
		expect(cohortSpec('whales', { topPct: -1 }).topPct).toBeGreaterThan(0);
		expect(cohortSpec('whales', {}).topPct).toBe(0.1); // default
	});

	it('new-buyers bounds first_seen from below (recent)', () => {
		const s = cohortSpec('new-buyers', { windowDays: 7 });
		expect(s.firstSeenAfter).toBeInstanceOf(Date);
		expect(s.firstSeenBefore).toBe(null);
		expect(s.firstSeenAfter.getTime()).toBeLessThanOrEqual(Date.now());
	});

	it('diamond-hands bounds first_seen from above (aged)', () => {
		const s = cohortSpec('diamond-hands', { minHoldDays: 30 });
		expect(s.firstSeenBefore).toBeInstanceOf(Date);
		expect(s.firstSeenAfter).toBe(null);
	});

	it('throws on unknown cohort', () => {
		expect(() => cohortSpec('nope')).toThrow();
	});
});

describe('deterministic sampling', () => {
	it('same (wallet, cohort, salt) always lands in the same bucket', () => {
		const w = 'THREEsyntheticWallet1111111111111111111111';
		expect(sampleBucket(w, 'whales', 'coin1')).toBe(sampleBucket(w, 'whales', 'coin1'));
	});

	it('salt changes the bucket (per-coin independence)', () => {
		const w = 'THREEsyntheticWallet1111111111111111111111';
		expect(sampleBucket(w, 'whales', 'coin1')).not.toBe(sampleBucket(w, 'whales', 'coin2'));
	});

	it('buckets stay in [0, 10000)', () => {
		for (let i = 0; i < 1000; i++) {
			const b = sampleBucket('wallet' + i, 'whales', 'salt');
			expect(b).toBeGreaterThanOrEqual(0);
			expect(b).toBeLessThan(10_000);
		}
	});

	it('a fraction p keeps roughly p of a large population', () => {
		let kept = 0;
		const N = 5000;
		for (let i = 0; i < N; i++) {
			if (inSample(sampleBucket('wallet' + i, 'whales', 's'), 0.1)) kept++;
		}
		// ~500 expected; allow generous slack for hash variance.
		expect(kept).toBeGreaterThan(400);
		expect(kept).toBeLessThan(600);
	});

	it('inSample is monotonic in the fraction', () => {
		const b = sampleBucket('somewallet', 'whales', 's');
		if (inSample(b, 0.1)) expect(inSample(b, 0.5)).toBe(true);
		if (!inSample(b, 0.5)) expect(inSample(b, 0.1)).toBe(false);
	});
});

import { describe, it, expect } from 'vitest';
import { isLiveCohort, liveCohortCounts, liveCohortMembers } from './cohorts-live.js';

// A live holder set: descending balances over synthetic $THREE wallets.
// (No DB / Helius — these are the pure derivations over an already-fetched set.)
function makeSet(amounts) {
	const holders = amounts
		.map((u, i) => ({ wallet: 'THREEsynthetic' + i, units: BigInt(u) }))
		.sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0));
	const totalUnits = holders.reduce((s, h) => s + h.units, 0n);
	return { holders, totalUnits };
}

describe('isLiveCohort', () => {
	it('only size cohorts compute without a snapshot', () => {
		expect(isLiveCohort('holders')).toBe(true);
		expect(isLiveCohort('whales')).toBe(true);
		expect(isLiveCohort('diamond-hands')).toBe(false);
		expect(isLiveCohort('new-buyers')).toBe(false);
		expect(isLiveCohort('exited')).toBe(false);
	});
});

describe('liveCohortCounts', () => {
	it('counts holders; tenure cohorts are null, never a fabricated 0', () => {
		const { holderCount, counts, concentration } = liveCohortCounts(
			makeSet([100, 50, 25, 10, 5, 4, 3, 2, 1, 1]),
			{},
		);
		expect(holderCount).toBe(10);
		expect(counts.holders).toBe(10);
		expect(counts['diamond-hands']).toBeNull();
		expect(counts['new-buyers']).toBeNull();
		expect(counts.exited).toBeNull();
		expect(concentration.top1Share).toBeGreaterThan(0);
		expect(concentration.top1Share).toBeLessThanOrEqual(1);
		expect(['none', 'healthy', 'moderate', 'high', 'very-high']).toContain(concentration.label);
	});

	it('whale slice tracks topPct', () => {
		const set = makeSet(Array.from({ length: 100 }, (_, i) => 100 - i));
		expect(liveCohortCounts(set, { topPct: 0.1 }).counts.whales).toBe(10);
		expect(liveCohortCounts(set, { topPct: 0.25 }).counts.whales).toBe(25);
	});

	it('empty set → zero holders, no NaN shares', () => {
		const { holderCount, counts, concentration } = liveCohortCounts(
			{ holders: [], totalUnits: 0n },
			{},
		);
		expect(holderCount).toBe(0);
		expect(counts.whales).toBe(0);
		expect(concentration.top1Share).toBe(0);
		expect(concentration.label).toBe('none');
	});

	it('top10Share = 1 when ≤10 wallets hold everything', () => {
		expect(liveCohortCounts(makeSet([5, 5, 5, 5, 5]), {}).concentration.top10Share).toBe(1);
	});
});

describe('liveCohortMembers', () => {
	const set = makeSet([100, 50, 25, 10, 5, 4, 3, 2, 1, 1]);

	it('holders cohort returns all, balance desc, no live tenure', () => {
		const { members } = liveCohortMembers(set, { cohortId: 'holders', limit: 100 });
		expect(members).toHaveLength(10);
		expect(BigInt(members[0].balance)).toBeGreaterThanOrEqual(BigInt(members[1].balance));
		expect(members[0].firstSeen).toBeNull();
	});

	it('whales cohort returns the top slice only', () => {
		const { members, total } = liveCohortMembers(set, {
			cohortId: 'whales',
			params: { topPct: 0.2 },
		});
		expect(total).toBe(2);
		expect(members).toHaveLength(2);
	});

	it('tenure cohorts throw snapshot_required', () => {
		expect(() => liveCohortMembers(set, { cohortId: 'diamond-hands' })).toThrow(/snapshot/i);
	});

	it('limit truncates and flags it', () => {
		const { members, truncated } = liveCohortMembers(set, { cohortId: 'holders', limit: 3 });
		expect(members).toHaveLength(3);
		expect(truncated).toBe(true);
	});

	it('sampling thins deterministically (~10% of 1000)', () => {
		const big = makeSet(Array.from({ length: 1000 }, (_, i) => 1000 - i));
		const a = liveCohortMembers(big, {
			cohortId: 'holders',
			limit: 1000,
			sample: 0.1,
			salt: 's',
		});
		const b = liveCohortMembers(big, {
			cohortId: 'holders',
			limit: 1000,
			sample: 0.1,
			salt: 's',
		});
		expect(a.total).toBe(b.total);
		expect(a.total).toBeGreaterThan(50);
		expect(a.total).toBeLessThan(150);
		expect(a.sampled).toBe(true);
	});
});

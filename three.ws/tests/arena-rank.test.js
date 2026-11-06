/**
 * Reputation Arena ordering — unit tests for src/shared/arena-rank.js.
 *
 * The wall's ranked order is a pure function of each agent's compact reputation,
 * so it can be proven here without a browser: rated agents outrank new ones,
 * new outrank unknown, higher scores win, and equal scores keep their incoming
 * (popular) order via a stable tie-break.
 */

import { describe, it, expect } from 'vitest';
import {
	arenaScore,
	compareArenaEntries,
	rankArena,
	ARENA_SCORE_NEW,
	ARENA_SCORE_UNKNOWN,
	TIER_RANK,
} from '../src/shared/arena-rank.js';

describe('arenaScore', () => {
	it('returns the trust score for a rated agent', () => {
		expect(arenaScore({ score: 72, tier: 'trusted' })).toBe(72);
		expect(arenaScore({ score: 0, tier: 'emerging' })).toBe(0);
	});

	it('sinks a brand-new agent below every real score', () => {
		expect(arenaScore({ isNew: true, score: 0 })).toBe(ARENA_SCORE_NEW);
		expect(ARENA_SCORE_NEW).toBeLessThan(0);
	});

	it('sinks an agent with no loaded reputation to the bottom', () => {
		expect(arenaScore(null)).toBe(ARENA_SCORE_UNKNOWN);
		expect(arenaScore(undefined)).toBe(ARENA_SCORE_UNKNOWN);
		expect(arenaScore({})).toBe(ARENA_SCORE_UNKNOWN); // no score, not new
	});

	it('new ranks above unknown', () => {
		expect(ARENA_SCORE_NEW).toBeGreaterThan(ARENA_SCORE_UNKNOWN);
	});

	it('treats a non-finite score as unknown, not zero', () => {
		expect(arenaScore({ score: NaN })).toBe(ARENA_SCORE_UNKNOWN);
		expect(arenaScore({ score: 'oops' })).toBe(ARENA_SCORE_UNKNOWN);
	});
});

describe('compareArenaEntries', () => {
	it('orders by score, highest first', () => {
		const a = { rep: { score: 40 }, index: 0 };
		const b = { rep: { score: 90 }, index: 1 };
		expect(compareArenaEntries(a, b)).toBeGreaterThan(0); // b before a
		expect(compareArenaEntries(b, a)).toBeLessThan(0);
	});

	it('breaks an exact score tie by tier rank, then original order', () => {
		const elite = { rep: { score: 60, tier: 'elite' }, index: 5 };
		const established = { rep: { score: 60, tier: 'established' }, index: 1 };
		expect(compareArenaEntries(elite, established)).toBeLessThan(0); // elite first
		expect(TIER_RANK.elite).toBeGreaterThan(TIER_RANK.established);
	});

	it('keeps incoming order when score and tier match (stable)', () => {
		const first = { rep: { score: 50, tier: 'emerging' }, index: 2 };
		const second = { rep: { score: 50, tier: 'emerging' }, index: 7 };
		expect(compareArenaEntries(first, second)).toBeLessThan(0); // lower index first
	});
});

describe('rankArena', () => {
	it('produces the full honest ordering: rated → new → unknown', () => {
		const entries = [
			{ id: 'unknown', rep: null },
			{ id: 'new', rep: { isNew: true } },
			{ id: 'mid', rep: { score: 55, tier: 'trusted' } },
			{ id: 'top', rep: { score: 91, tier: 'elite' } },
			{ id: 'low', rep: { score: 12, tier: 'emerging' } },
		];
		expect(rankArena(entries)).toEqual(['top', 'mid', 'low', 'new', 'unknown']);
	});

	it('is stable for an all-equal wall (no spurious reorder)', () => {
		const entries = ['a', 'b', 'c', 'd'].map((id) => ({ id, rep: { score: 50, tier: 'emerging' } }));
		expect(rankArena(entries)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('handles an empty wall', () => {
		expect(rankArena([])).toEqual([]);
		expect(rankArena(undefined)).toEqual([]);
	});
});

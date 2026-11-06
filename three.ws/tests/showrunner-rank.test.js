/**
 * Showrunner ranking — unit tests for src/shared/showrunner-rank.js.
 *
 * The wall's broadcast program is a pure function of the merged candidate set, so
 * the channel order can be proven here without a browser: live beats notable
 * beats featured beats popular; a fresh notable beat outranks a stale one of the
 * same kind; multiple candidates for one agent collapse to its best; and a true
 * tie resolves deterministically by recency then agentId (never random).
 */

import { describe, it, expect } from 'vitest';
import {
	tierOf,
	candidateScore,
	rankCandidates,
	programOrder,
	TIER_WEIGHT,
	NOTABLE_KINDS,
	DECAY_HALFLIFE_MS,
} from '../src/shared/showrunner-rank.js';

const NOW = 1_700_000_000_000;

describe('tierOf', () => {
	it('puts a live overlay above everything, regardless of kind', () => {
		expect(tierOf({ live: true, kind: 'popular' })).toBe('live');
		expect(tierOf({ live: true, kind: 'trade' })).toBe('live');
	});
	it('classifies the notable kinds', () => {
		for (const k of NOTABLE_KINDS) expect(tierOf({ kind: k })).toBe('notable');
	});
	it('classifies featured and popular', () => {
		expect(tierOf({ kind: 'featured' })).toBe('featured');
		expect(tierOf({ kind: 'popular' })).toBe('popular');
		expect(tierOf({})).toBe('popular');
		expect(tierOf(null)).toBe('popular');
	});
});

describe('candidateScore', () => {
	it('separates tiers by the full 1000-point spacing (intra-tier can never cross)', () => {
		const live = candidateScore({ live: true, ts: NOW, magnitude: 0 }, NOW);
		const notable = candidateScore({ kind: 'trade', ts: NOW, magnitude: 9_999 }, NOW);
		const featured = candidateScore({ kind: 'featured', ts: 0 }, NOW);
		const popular = candidateScore({ kind: 'popular', ts: 0 }, NOW);
		// A maxed-out notable still sits below the bottom of the live band.
		expect(live).toBeGreaterThan(notable);
		expect(notable).toBeGreaterThan(featured);
		expect(featured).toBeGreaterThan(popular);
		expect(live).toBeGreaterThanOrEqual(TIER_WEIGHT.live * 1000);
		expect(notable).toBeLessThan(TIER_WEIGHT.live * 1000);
	});

	it('decays a notable beat with age — fresh outranks stale of the same kind', () => {
		const fresh = candidateScore({ kind: 'forge', ts: NOW, magnitude: 1 }, NOW);
		const stale = candidateScore({ kind: 'forge', ts: NOW - DECAY_HALFLIFE_MS, magnitude: 1 }, NOW);
		const older = candidateScore({ kind: 'forge', ts: NOW - 4 * DECAY_HALFLIFE_MS, magnitude: 1 }, NOW);
		expect(fresh).toBeGreaterThan(stale);
		expect(stale).toBeGreaterThan(older);
	});

	it('rewards a bigger magnitude within a tier but with diminishing returns', () => {
		const small = candidateScore({ kind: 'trade', ts: NOW, magnitude: 5 }, NOW);
		const big = candidateScore({ kind: 'trade', ts: NOW, magnitude: 500 }, NOW);
		const huge = candidateScore({ kind: 'trade', ts: NOW, magnitude: 50_000 }, NOW);
		expect(big).toBeGreaterThan(small);
		expect(huge).toBeGreaterThan(big);
		// Saturation: 100× the magnitude is a small fraction more, never a tier jump.
		expect(huge - big).toBeLessThan(big - small + 1);
	});
});

describe('rankCandidates', () => {
	it('orders live > notable > featured > popular', () => {
		const out = rankCandidates([
			{ agentId: 'pop', kind: 'popular', ts: 0 },
			{ agentId: 'feat', kind: 'featured', ts: 0 },
			{ agentId: 'trade', kind: 'trade', ts: NOW, magnitude: 10 },
			{ agentId: 'live', kind: 'popular', ts: NOW, live: true },
		], { now: NOW });
		expect(out.map((c) => c.agentId)).toEqual(['live', 'trade', 'feat', 'pop']);
	});

	it('overlays the liveIds set so a live agent jumps to the top', () => {
		const out = rankCandidates([
			{ agentId: 'a', kind: 'popular', ts: 0 },
			{ agentId: 'b', kind: 'featured', ts: 0 },
		], { now: NOW, liveIds: new Set(['a']) });
		expect(out[0].agentId).toBe('a'); // 'a' is now live → outranks featured 'b'
	});

	it('collapses multiple candidates for one agent to its best', () => {
		const out = rankCandidates([
			{ agentId: 'x', kind: 'popular', ts: 0 },
			{ agentId: 'x', kind: 'trade', ts: NOW, magnitude: 20, reason: 'banked +$20' },
		], { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0].kind).toBe('trade');
		expect(out[0].reason).toBe('banked +$20');
	});

	it('breaks a genuine tie by recency, then agentId — deterministic, never random', () => {
		const a = rankCandidates([
			{ agentId: 'zeta', kind: 'popular', ts: 0 },
			{ agentId: 'alpha', kind: 'popular', ts: 0 },
		], { now: NOW }).map((c) => c.agentId);
		const b = rankCandidates([
			{ agentId: 'alpha', kind: 'popular', ts: 0 },
			{ agentId: 'zeta', kind: 'popular', ts: 0 },
		], { now: NOW }).map((c) => c.agentId);
		expect(a).toEqual(['alpha', 'zeta']); // agentId tie-break, order-independent
		expect(a).toEqual(b);
	});

	it('a more recent notable wins the tie when scores match on tier', () => {
		const out = rankCandidates([
			{ agentId: 'old', kind: 'verify', ts: NOW - 1000 },
			{ agentId: 'new', kind: 'verify', ts: NOW },
		], { now: NOW }).map((c) => c.agentId);
		expect(out).toEqual(['new', 'old']);
	});

	it('ignores candidates without an agentId', () => {
		const out = rankCandidates([
			{ kind: 'trade', ts: NOW },
			{ agentId: 'real', kind: 'popular', ts: 0 },
		], { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0].agentId).toBe('real');
	});

	it('handles an empty / nullish input gracefully', () => {
		expect(rankCandidates([], { now: NOW })).toEqual([]);
		expect(rankCandidates(null, { now: NOW })).toEqual([]);
		expect(rankCandidates(undefined)).toEqual([]);
	});
});

describe('programOrder', () => {
	it('returns just the ranked agentIds', () => {
		const ids = programOrder([
			{ agentId: 'pop', kind: 'popular', ts: 0 },
			{ agentId: 'live', kind: 'popular', ts: NOW, live: true },
		], { now: NOW });
		expect(ids).toEqual(['live', 'pop']);
	});
});

// Unit tests for the Agent Labor Market's pure economics (Moonshot 01).
// No DB / network — these guard the money math: the award score, reputation,
// the exact-integer settlement split, and the autonomous negotiation rule.

import { describe, it, expect } from 'vitest';
import {
	scoreBid, reputationFromStats, settlementSplit, defaultRoyaltyBps,
	negotiationPrice, etaForReputation, threeToAtomics, atomicsToThree,
	SCORE_WEIGHTS,
} from '../api/_lib/labor-economics.js';

describe('scoreBid', () => {
	it('is near 0 for a full-price, zero-reputation, very-slow bid (no price/rep credit, eta decayed away)', () => {
		const s = scoreBid({ priceAtomics: 1_000_000n, rewardAtomics: 1_000_000n, etaSeconds: 3600 * 1000, reputation: 0 });
		expect(s).toBeLessThan(0.05);
	});

	it('approaches 1 for a free, near-instant bid from a perfect-reputation worker', () => {
		const s = scoreBid({ priceAtomics: 0n, rewardAtomics: 1_000_000n, etaSeconds: 1, reputation: 1 });
		expect(s).toBeGreaterThan(0.99);
		expect(s).toBeLessThanOrEqual(1);
	});

	it('rewards a deeper discount monotonically', () => {
		const cheap = scoreBid({ priceAtomics: 200_000n, rewardAtomics: 1_000_000n, etaSeconds: 1800, reputation: 0.5 });
		const pricey = scoreBid({ priceAtomics: 800_000n, rewardAtomics: 1_000_000n, etaSeconds: 1800, reputation: 0.5 });
		expect(cheap).toBeGreaterThan(pricey);
	});

	it('rewards faster ETA and higher reputation', () => {
		const base = { priceAtomics: 500_000n, rewardAtomics: 1_000_000n };
		expect(scoreBid({ ...base, etaSeconds: 60, reputation: 0.5 })).toBeGreaterThan(scoreBid({ ...base, etaSeconds: 36000, reputation: 0.5 }));
		expect(scoreBid({ ...base, etaSeconds: 1800, reputation: 0.9 })).toBeGreaterThan(scoreBid({ ...base, etaSeconds: 1800, reputation: 0.1 }));
	});

	it('weights sum to 1 (a normalized score)', () => {
		expect(SCORE_WEIGHTS.price + SCORE_WEIGHTS.eta + SCORE_WEIGHTS.reputation).toBeCloseTo(1, 9);
	});

	it('clamps reputation out of range', () => {
		const over = scoreBid({ priceAtomics: 0n, rewardAtomics: 1_000_000n, etaSeconds: 0, reputation: 5 });
		expect(over).toBeLessThanOrEqual(1);
	});
});

describe('reputationFromStats', () => {
	it('gives a new agent a neutral-but-unproven prior (0.35)', () => {
		expect(reputationFromStats({})).toBe(0.35);
	});
	it('rises with success and volume, saturating volume at 10 jobs', () => {
		expect(reputationFromStats({ settled: 10, failed: 0 })).toBe(1); // 0.7*1 + 0.3*1
		expect(reputationFromStats({ settled: 5, failed: 0 })).toBeCloseTo(0.85, 5); // 0.7 + 0.3*0.5
	});
	it('punishes failures via success rate', () => {
		expect(reputationFromStats({ settled: 1, failed: 4 })).toBeLessThan(reputationFromStats({ settled: 4, failed: 1 }));
	});
});

describe('settlementSplit', () => {
	it('the three legs always sum to exactly the escrowed reward (no dust)', () => {
		for (const [reward, awarded] of [[1_000_000n, 800_000n], [999_999n, 333_333n], [7n, 7n], [10n, 3n]]) {
			const s = settlementSplit({ rewardAtomics: reward, awardedAtomics: awarded, royaltyBps: 1000, hasAuthor: true });
			expect(s.workerAtomics + s.royaltyAtomics + s.posterRefundAtomics).toBe(reward);
			expect(s.workerAtomics).toBeGreaterThanOrEqual(0n);
			expect(s.royaltyAtomics).toBeGreaterThanOrEqual(0n);
			expect(s.posterRefundAtomics).toBeGreaterThanOrEqual(0n);
		}
	});

	it('routes royalty out of the awarded amount only when there is an author', () => {
		const withAuthor = settlementSplit({ rewardAtomics: 1_000_000n, awardedAtomics: 1_000_000n, royaltyBps: 1000, hasAuthor: true });
		expect(withAuthor.royaltyAtomics).toBe(100_000n);
		expect(withAuthor.workerAtomics).toBe(900_000n);
		const noAuthor = settlementSplit({ rewardAtomics: 1_000_000n, awardedAtomics: 1_000_000n, royaltyBps: 1000, hasAuthor: false });
		expect(noAuthor.royaltyAtomics).toBe(0n);
		expect(noAuthor.workerAtomics).toBe(1_000_000n);
	});

	it('refunds the auction surplus (reward minus the lower winning bid) to the poster', () => {
		const s = settlementSplit({ rewardAtomics: 1_000_000n, awardedAtomics: 600_000n, royaltyBps: 0, hasAuthor: false });
		expect(s.posterRefundAtomics).toBe(400_000n);
		expect(s.workerAtomics).toBe(600_000n);
	});

	it('never pays out more than the escrow, even if the awarded amount exceeds it', () => {
		const s = settlementSplit({ rewardAtomics: 500_000n, awardedAtomics: 999_999n, royaltyBps: 1000, hasAuthor: true });
		expect(s.workerAtomics + s.royaltyAtomics + s.posterRefundAtomics).toBe(500_000n);
		expect(s.posterRefundAtomics).toBe(0n);
	});

	it('defaultRoyaltyBps is a sane 10% by default', () => {
		expect(defaultRoyaltyBps()).toBe(1000);
	});
});

describe('negotiationPrice', () => {
	it('never exceeds the reward or the worker max-bid ceiling', () => {
		expect(negotiationPrice({ rewardAtomics: 1_000_000n, maxBidAtomics: 400_000n, reputation: 1 })).toBeLessThanOrEqual(400_000n);
		expect(negotiationPrice({ rewardAtomics: 1_000_000n, maxBidAtomics: null, reputation: 1 })).toBeLessThanOrEqual(1_000_000n);
	});
	it('higher reputation holds nearer the ceiling; lower reputation discounts harder', () => {
		const high = negotiationPrice({ rewardAtomics: 1_000_000n, reputation: 1 });
		const low = negotiationPrice({ rewardAtomics: 1_000_000n, reputation: 0 });
		expect(high).toBeGreaterThan(low);
		expect(low).toBe(800_000n); // 0.80 × reward
		expect(high).toBe(980_000n); // 0.98 × reward
	});
	it('is always at least 1 atomic', () => {
		expect(negotiationPrice({ rewardAtomics: 1n, reputation: 0 })).toBeGreaterThanOrEqual(1n);
	});
});

describe('etaForReputation', () => {
	it('faster the higher the reputation, bounded 30m..2h', () => {
		expect(etaForReputation(0)).toBe(7200);
		expect(etaForReputation(1)).toBe(1800);
		expect(etaForReputation(0.5)).toBeGreaterThan(etaForReputation(1));
	});
});

describe('atomics conversion', () => {
	it('round-trips $THREE ↔ atomics at 6 decimals', () => {
		expect(threeToAtomics(1.5)).toBe(1_500_000n);
		expect(atomicsToThree(1_500_000n)).toBe(1.5);
		expect(threeToAtomics(-5)).toBe(0n); // never negative
	});
});

// Unit tests for the pro-rata rewards distribution (api/_lib/token/rewards.js).
// Pure math — proves it never over-distributes, conserves atoms, and is deterministic.

import { describe, it, expect } from 'vitest';
import { computeRewardsDistribution } from '../api/_lib/token/rewards.js';

describe('computeRewardsDistribution', () => {
	it('splits pro-rata by balance', () => {
		const r = computeRewardsDistribution({
			poolAtomics: 1000n,
			holders: [
				{ wallet: 'A', balance: 750n },
				{ wallet: 'B', balance: 250n },
			],
		});
		const a = r.payouts.find((p) => p.wallet === 'A');
		const b = r.payouts.find((p) => p.wallet === 'B');
		expect(a.atomics).toBe(750n);
		expect(b.atomics).toBe(250n);
		expect(r.distributed).toBe(1000n);
		expect(r.dust).toBe(0n);
	});

	it('conserves atoms — Σ payouts + dust === pool, remainder to the largest holder', () => {
		const r = computeRewardsDistribution({
			poolAtomics: 1000n,
			holders: [
				{ wallet: 'A', balance: 1n },
				{ wallet: 'B', balance: 1n },
				{ wallet: 'C', balance: 1n },
			],
		});
		const sum = r.payouts.reduce((s, p) => s + p.atomics, 0n);
		expect(sum + r.dust).toBe(1000n);
		// 1000/3 = 333 each, remainder 1 → largest holder (tie → first by wallet) gets 334.
		expect(r.payouts[0].atomics).toBe(334n);
	});

	it('never over-distributes a tiny pool across many holders', () => {
		const holders = Array.from({ length: 10 }, (_, i) => ({ wallet: `w${i}`, balance: 100n }));
		const r = computeRewardsDistribution({ poolAtomics: 5n, holders });
		const sum = r.payouts.reduce((s, p) => s + p.atomics, 0n);
		expect(sum).toBeLessThanOrEqual(5n);
		expect(sum + r.dust).toBe(5n);
	});

	it('drops dust payouts below the floor (atoms carry as dust)', () => {
		const r = computeRewardsDistribution({
			poolAtomics: 1000n,
			holders: [
				{ wallet: 'big', balance: 9999n },
				{ wallet: 'tiny', balance: 1n },
			],
			minPayoutAtomics: 10n,
		});
		// tiny's share (~0) is below the floor and dropped.
		expect(r.payouts.find((p) => p.wallet === 'tiny')).toBeUndefined();
		expect(r.distributed + r.dust).toBe(1000n);
	});

	it('drops zero/negative balances and handles an empty eligible set', () => {
		const r = computeRewardsDistribution({
			poolAtomics: 1000n,
			holders: [{ wallet: 'z', balance: 0n }],
		});
		expect(r.payouts).toHaveLength(0);
		expect(r.distributed).toBe(0n);
		expect(r.dust).toBe(1000n);
	});

	it('accepts string/number balances and pool', () => {
		const r = computeRewardsDistribution({
			poolAtomics: '100',
			holders: [{ wallet: 'A', balance: '50' }, { wallet: 'B', balance: 50 }],
		});
		expect(r.distributed).toBe(100n);
	});

	it('is deterministic for the same snapshot', () => {
		const holders = [
			{ wallet: 'B', balance: 300n },
			{ wallet: 'A', balance: 700n },
		];
		const r1 = computeRewardsDistribution({ poolAtomics: 1000n, holders });
		const r2 = computeRewardsDistribution({ poolAtomics: 1000n, holders });
		expect(r1.payouts).toEqual(r2.payouts);
		// Sorted by balance desc → A first.
		expect(r1.payouts[0].wallet).toBe('A');
	});
});

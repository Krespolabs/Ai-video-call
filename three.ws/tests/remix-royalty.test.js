import { describe, it, expect } from 'vitest';

import {
	clampRoyaltyBps,
	computeRemixSplit,
	atomicsToUsd,
	usdcToAtomics,
	REMIX_ROYALTY_CAP_BPS,
	REMIX_ROYALTY_DEFAULT_BPS,
	REMIX_MIN_PAYOUT_ATOMICS,
} from '../api/_lib/remix-royalty.js';

describe('clampRoyaltyBps', () => {
	it('passes through a valid rate', () => {
		expect(clampRoyaltyBps(1000)).toBe(1000);
	});
	it('clamps above the cap', () => {
		expect(clampRoyaltyBps(5000)).toBe(REMIX_ROYALTY_CAP_BPS);
	});
	it('floors negatives / garbage to 0', () => {
		expect(clampRoyaltyBps(-1)).toBe(0);
		expect(clampRoyaltyBps(NaN)).toBe(0);
		expect(clampRoyaltyBps('abc')).toBe(0);
	});
});

describe('computeRemixSplit — split math', () => {
	it('splits a 1 USDC remix at the default 10% royalty', () => {
		// 1 USDC = 1_000_000 atomics; 10% = 100_000 to the creator.
		const s = computeRemixSplit({ priceAtomics: 1_000_000n, royaltyBps: REMIX_ROYALTY_DEFAULT_BPS });
		expect(s.creatorAtomics).toBe(100_000n);
		expect(s.platformAtomics).toBe(900_000n);
		expect(s.royaltyBps).toBe(1000);
		expect(s.capped).toBe(false);
		expect(s.dust).toBe(false);
		expect(s.creatorUsd).toBeCloseTo(0.1, 9);
	});

	it('conserves value: creator + platform === price for many inputs', () => {
		const prices = [1n, 999n, 1_000_000n, 3_333_333n, 50_000_000n, 123_456_789n];
		const rates = [0, 1, 250, 1000, 2000, 9999];
		for (const p of prices) {
			for (const r of rates) {
				const s = computeRemixSplit({ priceAtomics: p, royaltyBps: r });
				expect(s.creatorAtomics + s.platformAtomics).toBe(p);
				expect(s.creatorAtomics >= 0n).toBe(true);
				expect(s.platformAtomics >= 0n).toBe(true);
			}
		}
	});

	it('enforces the hard cap — a 50% request is clamped to 20%', () => {
		const s = computeRemixSplit({ priceAtomics: 10_000_000n, royaltyBps: 5000 });
		expect(s.requestedBps).toBe(5000);
		expect(s.royaltyBps).toBe(REMIX_ROYALTY_CAP_BPS);
		expect(s.capped).toBe(true);
		// 20% of 10 USDC = 2 USDC; remixer keeps the 80% majority on the platform side.
		expect(s.creatorAtomics).toBe(2_000_000n);
		expect(s.platformAtomics).toBe(8_000_000n);
	});

	it('the remixer always keeps the clear majority (platform >= creator)', () => {
		const s = computeRemixSplit({ priceAtomics: 7_777_777n, royaltyBps: REMIX_ROYALTY_CAP_BPS });
		expect(s.platformAtomics > s.creatorAtomics).toBe(true);
	});

	it('drops a sub-dust royalty rather than paying it', () => {
		// Tiny price where 1% rounds below the dust floor (500 < 10_000 atomics).
		const s = computeRemixSplit({ priceAtomics: 50_000n, royaltyBps: 100 });
		expect(s.creatorAtomics).toBe(0n); // sub-dust royalty dropped, not paid
		expect(s.dust).toBe(true);
		expect(s.platformAtomics).toBe(50_000n);
	});

	it('floors the royalty (no fractional atomics created)', () => {
		// 333 atomics at 10% = 33.3 → floor 33; but that's sub-dust so it drops to 0.
		const s = computeRemixSplit({ priceAtomics: 333n, royaltyBps: 1000 });
		expect(s.creatorAtomics).toBe(0n);
		expect(s.creatorAtomics + s.platformAtomics).toBe(333n);
	});

	it('zero royalty rate routes everything to the platform', () => {
		const s = computeRemixSplit({ priceAtomics: 1_000_000n, royaltyBps: 0 });
		expect(s.creatorAtomics).toBe(0n);
		expect(s.platformAtomics).toBe(1_000_000n);
	});

	it('defaults the royalty rate when none is given', () => {
		const s = computeRemixSplit({ priceAtomics: 1_000_000n });
		expect(s.royaltyBps).toBe(REMIX_ROYALTY_DEFAULT_BPS);
		expect(s.creatorAtomics).toBe(100_000n);
	});

	it('accepts string and number price inputs (bazaar stores atomics as text)', () => {
		expect(computeRemixSplit({ priceAtomics: '1000000', royaltyBps: 1000 }).creatorAtomics).toBe(100_000n);
		expect(computeRemixSplit({ priceAtomics: 1_000_000, royaltyBps: 1000 }).creatorAtomics).toBe(100_000n);
	});

	it('treats invalid / zero price as no payout', () => {
		expect(computeRemixSplit({ priceAtomics: 0n, royaltyBps: 1000 }).creatorAtomics).toBe(0n);
		expect(computeRemixSplit({ priceAtomics: 'xyz', royaltyBps: 1000 }).priceAtomics).toBe(0n);
	});
});

describe('USDC atomics helpers', () => {
	it('round-trips whole and fractional USDC', () => {
		expect(usdcToAtomics(1)).toBe(1_000_000n);
		expect(usdcToAtomics(0.25)).toBe(250_000n);
		expect(atomicsToUsd(1_000_000n)).toBe(1);
		expect(atomicsToUsd(250_000n)).toBe(0.25);
	});
	it('never returns negative atomics', () => {
		expect(usdcToAtomics(-5)).toBe(0n);
	});
});

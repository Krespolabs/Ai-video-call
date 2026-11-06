// Unit tests for the pure subscription pricing + period math.
//
// No DB, no RPC, no Solana — verifies USD→USDC atomic conversion (with correct
// rounding) and the weekly/monthly period window used to set a subscription's
// current_period_end.

import { describe, it, expect } from 'vitest';
import {
	USDC_MAINNET_MINT,
	USDC_DECIMALS,
	usdToUsdcAtomics,
	intervalMs,
	computePeriod,
} from '../../api/_lib/subscription-pricing.js';

const DAY = 24 * 3600 * 1000;

describe('subscription-pricing', () => {
	it('exposes the canonical USDC mint at 6 decimals', () => {
		expect(USDC_MAINNET_MINT).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
		expect(USDC_DECIMALS).toBe(6);
	});

	describe('usdToUsdcAtomics', () => {
		it('converts whole and fractional dollars to 6-decimal atomics', () => {
			expect(usdToUsdcAtomics(1)).toBe(1_000_000n);
			expect(usdToUsdcAtomics(9.99)).toBe(9_990_000n);
			expect(usdToUsdcAtomics(0.5)).toBe(500_000n);
		});

		it('rounds to the nearest atomic instead of truncating', () => {
			// 4.9999 * 1e6 = 4_999_900 exactly; 4.99999 rounds up to 5_000_000 - 10.
			expect(usdToUsdcAtomics(4.9999)).toBe(4_999_900n);
			expect(usdToUsdcAtomics(0.0000004)).toBe(0n); // below half an atomic → 0
			expect(usdToUsdcAtomics(0.0000006)).toBe(1n); // above half an atomic → 1
		});

		it('accepts numeric strings (Postgres numeric comes back as a string)', () => {
			expect(usdToUsdcAtomics('19.99')).toBe(19_990_000n);
		});

		it('returns 0 for a zero price', () => {
			expect(usdToUsdcAtomics(0)).toBe(0n);
		});

		it('throws on a negative or non-finite price', () => {
			expect(() => usdToUsdcAtomics(-1)).toThrow('invalid price');
			expect(() => usdToUsdcAtomics(Number.NaN)).toThrow('invalid price');
			expect(() => usdToUsdcAtomics('abc')).toThrow('invalid price');
		});
	});

	describe('intervalMs', () => {
		it('is 7 days for weekly', () => {
			expect(intervalMs('weekly')).toBe(7 * DAY);
		});
		it('is 30 days for monthly', () => {
			expect(intervalMs('monthly')).toBe(30 * DAY);
		});
		it('defaults unknown intervals to the monthly window', () => {
			expect(intervalMs('quarterly')).toBe(30 * DAY);
			expect(intervalMs(undefined)).toBe(30 * DAY);
		});
	});

	describe('computePeriod', () => {
		it('returns start = from and end = from + interval (weekly)', () => {
			const from = new Date('2026-06-18T00:00:00.000Z');
			const { start, end } = computePeriod('weekly', from);
			expect(start.toISOString()).toBe('2026-06-18T00:00:00.000Z');
			expect(end.toISOString()).toBe('2026-06-25T00:00:00.000Z');
		});

		it('advances by 30 days for monthly', () => {
			const from = new Date('2026-06-18T12:00:00.000Z');
			const { end } = computePeriod('monthly', from);
			expect(end.getTime() - from.getTime()).toBe(30 * DAY);
		});

		it('does not mutate the passed-in date', () => {
			const from = new Date('2026-06-18T00:00:00.000Z');
			const snapshot = from.getTime();
			computePeriod('monthly', from);
			expect(from.getTime()).toBe(snapshot);
		});
	});
});

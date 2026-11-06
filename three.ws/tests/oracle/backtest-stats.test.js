// Unit tests for the Oracle backtest's statistical helpers. These numbers back
// the public "the edge is real" claim on /oracle, so the math has to be right.

import { describe, it, expect } from 'vitest';
import { wilson } from '../../api/oracle/backtest.js';

describe('wilson score interval', () => {
	it('returns null for an empty sample', () => {
		expect(wilson(0, 0)).toBeNull();
		expect(wilson(5, 0)).toBeNull();
	});

	it('brackets the point estimate', () => {
		const ci = wilson(7, 10); // 70%
		expect(ci.lo).toBeLessThanOrEqual(70);
		expect(ci.hi).toBeGreaterThanOrEqual(70);
	});

	it('stays inside [0,100] even at the extremes', () => {
		const all = wilson(10, 10); // 100%
		expect(all.lo).toBeGreaterThanOrEqual(0);
		expect(all.hi).toBeLessThanOrEqual(100);
		const none = wilson(0, 10); // 0%
		expect(none.lo).toBeGreaterThanOrEqual(0);
		expect(none.hi).toBeLessThanOrEqual(100);
	});

	it('produces a wider band for a smaller sample at the same rate', () => {
		const small = wilson(7, 10);   // 70% of 10
		const large = wilson(700, 1000); // 70% of 1000
		expect(small.width).toBeGreaterThan(large.width);
	});

	it('narrows toward the point estimate as n grows', () => {
		const huge = wilson(7000, 10000); // 70% of 10k
		expect(huge.lo).toBeGreaterThan(68);
		expect(huge.hi).toBeLessThan(72);
	});

	it('matches the Wilson reference value (7/10 ≈ 40–89 at 95%)', () => {
		const ci = wilson(7, 10);
		// Wilson 95% score interval for 7/10 ≈ 0.397–0.892.
		expect(ci.lo).toBeGreaterThanOrEqual(38);
		expect(ci.lo).toBeLessThanOrEqual(42);
		expect(ci.hi).toBeGreaterThanOrEqual(87);
		expect(ci.hi).toBeLessThanOrEqual(91);
	});
});

// Owner economy summary — earnings composition (api/_lib/economy-shape.js).
//
// The agent economy's headline income is one agent hiring another over the x402
// mesh. That income must surface as its own `hires` bucket and roll into the
// total alongside skill sales and tips — never be silently lumped into "tips" or
// double-counted. These tests lock that contract down.

import { describe, it, expect } from 'vitest';
import { composeEarnings } from '../api/_lib/economy-shape.js';

describe('composeEarnings', () => {
	it('keeps skill sales, hires, and tips as three distinct buckets', () => {
		const e = composeEarnings({
			skill_sales: { today: 1, week: 2, lifetime: 10, count: 5 },
			hires: { today: 3, week: 4, lifetime: 20, count: 7 },
			tips: { today: 0.5, week: 1.5, lifetime: 5, count: 9 },
		});
		expect(e.skill_sales.lifetime).toBe(10);
		expect(e.hires.lifetime).toBe(20);
		expect(e.tips.lifetime).toBe(5);
		expect(e.hires.count).toBe(7);
	});

	it('totals all three streams across every window without double-counting', () => {
		const e = composeEarnings({
			skill_sales: { today: 1, week: 2, lifetime: 10, count: 5 },
			hires: { today: 3, week: 4, lifetime: 20, count: 7 },
			tips: { today: 0.5, week: 1.5, lifetime: 5, count: 9 },
		});
		expect(e.total.today).toBe(4.5);
		expect(e.total.week).toBe(7.5);
		expect(e.total.lifetime).toBe(35);
		expect(e.total.count).toBe(21);
	});

	it('surfaces hire income in the total even with zero sales and tips', () => {
		const e = composeEarnings({
			skill_sales: { today: 0, week: 0, lifetime: 0, count: 0 },
			hires: { today: 2, week: 6, lifetime: 42, count: 3 },
			tips: { today: 0, week: 0, lifetime: 0, count: 0 },
		});
		expect(e.total.lifetime).toBe(42);
		expect(e.total.count).toBe(3);
	});

	it('preserves extra bucket fields (e.g. skill_sales.non_usdc_count)', () => {
		const e = composeEarnings({
			skill_sales: { today: 0, week: 0, lifetime: 0, count: 0, non_usdc_count: 4 },
			hires: { today: 0, week: 0, lifetime: 0, count: 0 },
			tips: { today: 0, week: 0, lifetime: 0, count: 0 },
		});
		expect(e.skill_sales.non_usdc_count).toBe(4);
	});

	it('defaults missing buckets and non-numeric values to zero', () => {
		const e = composeEarnings({ hires: { lifetime: 'oops', count: null } });
		expect(e.total.lifetime).toBe(0);
		expect(e.total.count).toBe(0);
		expect(e.skill_sales).toEqual({});
		expect(e.tips).toEqual({});
	});

	it('returns a zeroed total when called with no arguments', () => {
		const e = composeEarnings();
		expect(e.total).toEqual({ today: 0, week: 0, lifetime: 0, count: 0 });
	});
});

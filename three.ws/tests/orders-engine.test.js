/**
 * Programmable Orders Engine — unit tests for the pure model + trigger logic
 * (api/_lib/orders.js). These are the rules the API and the worker both enforce,
 * so they're tested once, in isolation, with no DB or chain.
 *
 * Coverage: condition-spec validation (closed vocabulary, code-free), condition
 * evaluation (including honest handling of missing live data), price-trigger
 * direction for every (type, side), order normalization per type, and the
 * human-readable description. The only mint used is $THREE (per CLAUDE.md).
 */

import { describe, it, expect } from 'vitest';
import {
	validateCondition, evaluateCondition, conditionSignals,
	shouldFirePrice, normalizeOrder, describeOrder,
} from '../api/_lib/orders.js';

// $THREE — the only coin this platform references.
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('validateCondition', () => {
	it('accepts a valid all-clause numeric + bool spec', () => {
		const r = validateCondition({ all: [
			{ signal: 'smart_money_score', op: 'gte', value: 60 },
			{ signal: 'dev_dump', op: 'is_false' },
		] });
		expect(r.ok).toBe(true);
		expect(r.spec.all).toHaveLength(2);
		expect(r.spec.all[1]).toEqual({ signal: 'dev_dump', op: 'is_false' });
	});

	it('rejects an unknown signal (closed vocabulary)', () => {
		expect(validateCondition({ all: [{ signal: 'rsi', op: 'gt', value: 70 }] }).ok).toBe(false);
	});

	it('rejects a numeric op on a boolean signal and vice-versa', () => {
		expect(validateCondition({ all: [{ signal: 'dev_dump', op: 'gt', value: 1 }] }).ok).toBe(false);
		expect(validateCondition({ all: [{ signal: 'mcap_usd', op: 'is_true' }] }).ok).toBe(false);
	});

	it('rejects a non-numeric value on a numeric signal', () => {
		expect(validateCondition({ all: [{ signal: 'mcap_usd', op: 'lt', value: 'soon' }] }).ok).toBe(false);
	});

	it('requires a non-empty all/any array and caps clause count', () => {
		expect(validateCondition({}).ok).toBe(false);
		expect(validateCondition({ all: [] }).ok).toBe(false);
		const many = { all: Array.from({ length: 9 }, () => ({ signal: 'mcap_usd', op: 'lt', value: 1 })) };
		expect(validateCondition(many).ok).toBe(false);
	});

	it('strips arbitrary keys — no code can ride along', () => {
		const r = validateCondition({ all: [{ signal: 'mcap_usd', op: 'lt', value: 40000, evil: 'rm -rf', fn: () => {} }] });
		expect(r.ok).toBe(true);
		expect(Object.keys(r.spec.all[0]).sort()).toEqual(['op', 'signal', 'value']);
	});
});

describe('evaluateCondition', () => {
	const spec = validateCondition({ all: [
		{ signal: 'smart_money_score', op: 'gte', value: 60 },
		{ signal: 'mcap_usd', op: 'lt', value: 40000 },
	] }).spec;

	it('fires when all clauses are satisfied', () => {
		expect(evaluateCondition(spec, { smart_money_score: 72, mcap_usd: 30000 }).fired).toBe(true);
	});

	it('does not fire when one clause fails', () => {
		expect(evaluateCondition(spec, { smart_money_score: 72, mcap_usd: 50000 }).fired).toBe(false);
	});

	it('treats missing data as indeterminate (never fires on a gap) and reports it', () => {
		const r = evaluateCondition(spec, { smart_money_score: 72, mcap_usd: null });
		expect(r.fired).toBe(false);
		expect(r.missing).toContain('mcap_usd');
	});

	it('any-mode fires when a single present clause is true even if another is missing', () => {
		const any = validateCondition({ any: [
			{ signal: 'graduated', op: 'is_true' },
			{ signal: 'smart_money_score', op: 'gte', value: 60 },
		] }).spec;
		expect(evaluateCondition(any, { graduated: true, smart_money_score: null }).fired).toBe(true);
	});

	it('conditionSignals lists the distinct referenced signals', () => {
		expect(conditionSignals(spec).sort()).toEqual(['mcap_usd', 'smart_money_score']);
	});
});

describe('shouldFirePrice', () => {
	it('limit buy fires at/below target; limit sell at/above', () => {
		expect(shouldFirePrice({ type: 'limit', side: 'buy', limit_price: 100 }, 100)).toBe(true);
		expect(shouldFirePrice({ type: 'limit', side: 'buy', limit_price: 100 }, 101)).toBe(false);
		expect(shouldFirePrice({ type: 'limit', side: 'sell', limit_price: 100 }, 100)).toBe(true);
		expect(shouldFirePrice({ type: 'limit', side: 'sell', limit_price: 100 }, 99)).toBe(false);
	});

	it('stop sell fires on a fall; stop buy on a breakout', () => {
		expect(shouldFirePrice({ type: 'stop', side: 'sell', stop_price: 50 }, 49)).toBe(true);
		expect(shouldFirePrice({ type: 'stop', side: 'sell', stop_price: 50 }, 51)).toBe(false);
		expect(shouldFirePrice({ type: 'stop', side: 'buy', stop_price: 50 }, 51)).toBe(true);
	});

	it('trailing sell fires after a % drawdown from the peak', () => {
		const o = { type: 'trailing', side: 'sell', trail_pct: 20 };
		expect(shouldFirePrice(o, 80, 100)).toBe(true);   // -20% from peak 100
		expect(shouldFirePrice(o, 85, 100)).toBe(false);  // only -15%
		expect(shouldFirePrice(o, 80, null)).toBe(false); // no peak yet → hold
	});

	it('trailing buy fires after a % run-up from the trough', () => {
		const o = { type: 'trailing', side: 'buy', trail_pct: 10 };
		expect(shouldFirePrice(o, 111, 100)).toBe(true);  // +11% from trough 100
		expect(shouldFirePrice(o, 105, 100)).toBe(false); // only +5%
	});

	it('never fires on a non-finite value', () => {
		expect(shouldFirePrice({ type: 'limit', side: 'buy', limit_price: 100 }, NaN)).toBe(false);
	});
});

describe('normalizeOrder', () => {
	it('validates a limit buy', () => {
		const r = normalizeOrder({ type: 'limit', side: 'buy', mint: THREE, trigger_metric: 'mcap_usd', limit_price: 40000, size_sol: 0.25 });
		expect(r.ok).toBe(true);
		expect(r.order.limit_price).toBe(40000);
		expect(r.order.size_sol).toBe(0.25);
	});

	it('rejects a bad mint', () => {
		expect(normalizeOrder({ type: 'limit', side: 'buy', mint: 'not-a-mint', limit_price: 1, size_sol: 1 }).ok).toBe(false);
	});

	it('requires size_sol for a buy and sell sizing for a sell', () => {
		expect(normalizeOrder({ type: 'limit', side: 'buy', mint: THREE, limit_price: 1 }).ok).toBe(false);
		const sell = normalizeOrder({ type: 'limit', side: 'sell', mint: THREE, limit_price: 1, sell_pct: 50 });
		expect(sell.ok).toBe(true);
		expect(sell.order.sell_pct).toBe(50);
	});

	it('rejects sell_pct out of range', () => {
		expect(normalizeOrder({ type: 'stop', side: 'sell', mint: THREE, stop_price: 1, sell_pct: 150 }).ok).toBe(false);
	});

	it('validates trailing trail_pct bounds', () => {
		expect(normalizeOrder({ type: 'trailing', side: 'sell', mint: THREE, trail_pct: 0, sell_pct: 100 }).ok).toBe(false);
		expect(normalizeOrder({ type: 'trailing', side: 'sell', mint: THREE, trail_pct: 25, sell_pct: 100 }).ok).toBe(true);
	});

	it('validates a DCA schedule and seeds filled_slices', () => {
		const r = normalizeOrder({ type: 'dca', side: 'buy', mint: THREE, size_sol: 0.1, schedule: { interval_seconds: 3600, slices: 6 } });
		expect(r.ok).toBe(true);
		expect(r.order.schedule).toEqual({ interval_seconds: 3600, slices: 6, filled_slices: 0 });
	});

	it('rejects a too-frequent DCA schedule', () => {
		expect(normalizeOrder({ type: 'dca', side: 'buy', mint: THREE, size_sol: 0.1, schedule: { interval_seconds: 5, slices: 6 } }).ok).toBe(false);
	});

	it('derives TWAP per-slice size from the total', () => {
		const r = normalizeOrder({ type: 'twap', side: 'buy', mint: THREE, total_sol: 1, schedule: { interval_seconds: 60, slices: 4 } });
		expect(r.ok).toBe(true);
		expect(r.order.size_sol).toBeCloseTo(0.25, 8);
		expect(r.order.schedule.total_sol).toBe(1);
	});

	it('requires ≥2 slices for TWAP', () => {
		expect(normalizeOrder({ type: 'twap', side: 'buy', mint: THREE, total_sol: 1, schedule: { interval_seconds: 60, slices: 1 } }).ok).toBe(false);
	});

	it('validates a conditional order and keeps the clean spec', () => {
		const r = normalizeOrder({ type: 'conditional', side: 'buy', mint: THREE, size_sol: 0.2, condition: { all: [{ signal: 'smart_money_score', op: 'gte', value: 60 }] } });
		expect(r.ok).toBe(true);
		expect(r.order.condition.all[0]).toEqual({ signal: 'smart_money_score', op: 'gte', value: 60 });
	});

	it('rejects a conditional order with an invalid condition', () => {
		expect(normalizeOrder({ type: 'conditional', side: 'buy', mint: THREE, size_sol: 0.2, condition: { all: [{ signal: 'nope', op: 'gt', value: 1 }] } }).ok).toBe(false);
	});

	it('clamps slippage and rejects a bad expiry', () => {
		const r = normalizeOrder({ type: 'limit', side: 'buy', mint: THREE, limit_price: 1, size_sol: 1, slippage_bps: 99999 });
		expect(r.order.slippage_bps).toBe(5000);
		expect(normalizeOrder({ type: 'limit', side: 'buy', mint: THREE, limit_price: 1, size_sol: 1, expires_at: 'whenever' }).ok).toBe(false);
	});
});

describe('describeOrder', () => {
	it('reads back each order type in plain language', () => {
		const limit = normalizeOrder({ type: 'limit', side: 'buy', mint: THREE, symbol: 'THREE', limit_price: 40000, size_sol: 0.25 }).order;
		expect(describeOrder(limit)).toMatch(/Buy 0.25 SOL of \$THREE when it reaches \$40,000 mcap/);

		const trail = normalizeOrder({ type: 'trailing', side: 'sell', mint: THREE, symbol: 'THREE', trail_pct: 20, sell_pct: 100 }).order;
		expect(describeOrder(trail)).toMatch(/Trailing stop.*20% drop/);

		const cond = normalizeOrder({ type: 'conditional', side: 'buy', mint: THREE, symbol: 'THREE', size_sol: 0.2, condition: { all: [{ signal: 'smart_money_score', op: 'gte', value: 60 }, { signal: 'dev_dump', op: 'is_false' }] } }).order;
		expect(describeOrder(cond)).toMatch(/Smart-money score.*≥ 60 and/);
	});
});

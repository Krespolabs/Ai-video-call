/**
 * Copy-trade mirror — pure logic tests.
 * Money-adjacent sizing + latency + blocked-row mapping, pinned so a regression
 * can't silently change how a replicated order is sized or reported.
 */

import { describe, it, expect } from 'vitest';
import {
	sizeMirrorOrder, computeLatency, mapBlockedReason,
	isValidAddress, truncateAddr, fmtSol,
} from '../src/agent-screen-mirror.js';

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('sizeMirrorOrder', () => {
	it('fixed → the fixed amount regardless of source size', () => {
		const r = sizeMirrorOrder('fixed', { fixedSol: 0.05, leaderSol: 4 });
		expect(r).toEqual({ ok: true, order: 0.05, raw: 0.05 });
	});

	it('multiplier → source SOL × multiplier', () => {
		const r = sizeMirrorOrder('multiplier', { leaderSol: 0.4, multiplier: 0.25 });
		expect(r.ok).toBe(true);
		expect(r.order).toBeCloseTo(0.1, 9);
	});

	it('pct_balance → % of the agent balance', () => {
		const r = sizeMirrorOrder('pct_balance', { balanceSol: 2, pctBalance: 5 });
		expect(r.ok).toBe(true);
		expect(r.order).toBeCloseTo(0.1, 9);
	});

	it('pct_balance without a known balance is unsizable', () => {
		const r = sizeMirrorOrder('pct_balance', { balanceSol: null, pctBalance: 5 });
		expect(r).toEqual({ ok: false, reason: 'sizing_unavailable' });
	});

	it('clamps to the per-trade cap', () => {
		const r = sizeMirrorOrder('multiplier', { leaderSol: 5, multiplier: 1, perTxCapSol: 0.5 });
		expect(r.ok).toBe(true);
		expect(r.order).toBe(0.5);
	});

	it('rejects an order below the configured minimum', () => {
		const r = sizeMirrorOrder('multiplier', { leaderSol: 1, multiplier: 0.001, minOrderSol: 0.01 });
		expect(r).toEqual({ ok: false, reason: 'below_min_order', raw: 0.001 });
	});

	it('a zero/negative fixed size is rejected, never sent as a real order', () => {
		expect(sizeMirrorOrder('fixed', { fixedSol: 0 }).ok).toBe(false);
		expect(sizeMirrorOrder('fixed', { fixedSol: -1 }).ok).toBe(false);
	});

	it('a cap of zero is treated as "no cap" (does not zero the order)', () => {
		const r = sizeMirrorOrder('fixed', { fixedSol: 0.05, perTxCapSol: 0 });
		expect(r.order).toBe(0.05);
	});
});

describe('computeLatency', () => {
	it('returns submitted − detected in ms', () => {
		expect(computeLatency(1000, 1380)).toBe(380);
	});
	it('floors at 0 for clock skew', () => {
		expect(computeLatency(2000, 1500)).toBe(0);
	});
	it('null on non-finite inputs', () => {
		expect(computeLatency(undefined, 10)).toBeNull();
		expect(computeLatency(10, NaN)).toBeNull();
	});
});

describe('mapBlockedReason', () => {
	it('prefers the server message and labels known guard codes', () => {
		const r = mapBlockedReason({ code: 'per_trade_cap', message: 'over the cap' });
		expect(r.code).toBe('per_trade_cap');
		expect(r.label).toBe('Over per-trade cap');
		expect(r.message).toBe('over the cap');
	});

	it('maps the price-impact breaker', () => {
		expect(mapBlockedReason({ code: 'price_impact' }).label).toBe('Price impact too high');
	});

	it('maps client-side sizing rejections to actionable copy', () => {
		expect(mapBlockedReason({ code: 'below_min_order' }).label).toBe('Below minimum order');
		expect(mapBlockedReason({ reason: 'sizing_unavailable' }).label).toBe('Sizing unavailable');
	});

	it('falls back to a generic label for unknown codes', () => {
		const r = mapBlockedReason({ code: 'something_new' });
		expect(r.label).toBe('Blocked');
		expect(r.message).toContain('something_new');
	});
});

describe('isValidAddress / truncateAddr', () => {
	it('accepts the $THREE mint and rejects junk', () => {
		expect(isValidAddress(THREE)).toBe(true);
		expect(isValidAddress('not-an-address')).toBe(false);
		expect(isValidAddress('')).toBe(false);
		expect(isValidAddress(null)).toBe(false);
	});

	it('truncates long addresses and leaves short ones intact', () => {
		expect(truncateAddr(THREE, 4, 4)).toBe('FeMb…pump');
		expect(truncateAddr('abc')).toBe('abc');
	});
});

describe('fmtSol', () => {
	it('trims trailing zeros and renders 0 cleanly', () => {
		expect(fmtSol(0.5000)).toBe('0.5');
		expect(fmtSol(0)).toBe('0');
		expect(fmtSol(0.123, 4)).toBe('0.123');
	});
});

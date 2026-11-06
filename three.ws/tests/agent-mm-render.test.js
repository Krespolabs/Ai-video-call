import { describe, it, expect } from 'vitest';
import {
	mmActionType,
	isFiredKind,
	normalizeFloor,
	fmtSizeSol,
	fmtPriceSol,
	mmSummary,
	mmEventFromOutcome,
	sanitizeMmEvent,
	MM_ACTION_TYPES,
} from '../src/shared/mm-render.js';

describe('mmActionType — engine kind → screen action_type', () => {
	it('maps every fired kind to its action_type', () => {
		expect(mmActionType('seed')).toBe('mm_seed');
		expect(mmActionType('defend_buy')).toBe('mm_defend');
		expect(mmActionType('recycle_sell')).toBe('mm_recycle');
		expect(mmActionType('rebalance_trim')).toBe('mm_rebalance');
		expect(mmActionType('graduation_lp')).toBe('mm_graduate');
		expect(mmActionType('graduation_distribute')).toBe('mm_graduate');
		expect(mmActionType('graduation_hold')).toBe('mm_quote');
	});

	it('falls back to mm_quote for non-firing / unknown tags', () => {
		for (const t of ['in_band', 'interval_guard', 'daily_budget', 'no_price', 'no_wallet', 'anything']) {
			expect(mmActionType(t)).toBe('mm_quote');
		}
	});

	it('only ever emits known action_types', () => {
		const tags = ['seed', 'defend_buy', 'recycle_sell', 'rebalance_trim', 'graduation_lp', 'graduation_distribute', 'graduation_hold', 'in_band'];
		for (const t of tags) expect(MM_ACTION_TYPES).toContain(mmActionType(t));
	});
});

describe('isFiredKind — real fill vs quote/guard', () => {
	it('treats real fills as fired', () => {
		for (const k of ['seed', 'defend_buy', 'recycle_sell', 'rebalance_trim', 'graduation_lp', 'graduation_distribute']) {
			expect(isFiredKind(k)).toBe(true);
		}
	});
	it('treats quotes / holds / guards as not fired', () => {
		for (const k of ['graduation_hold', 'in_band', 'interval_guard', 'no_price', 'no_wallet', undefined, null]) {
			expect(isFiredKind(k)).toBe(false);
		}
	});
});

describe('normalizeFloor — render-safe SOL units', () => {
	it('passes finite non-negative numbers through', () => {
		expect(normalizeFloor({ floorSol: 0.0000142, priceSol: 0.0000151 })).toEqual({ floorSol: 0.0000142, priceSol: 0.0000151 });
	});
	it('clamps NaN / negative / missing / string to 0', () => {
		expect(normalizeFloor({ floorSol: NaN, priceSol: -1 })).toEqual({ floorSol: 0, priceSol: 0 });
		expect(normalizeFloor({})).toEqual({ floorSol: 0, priceSol: 0 });
		expect(normalizeFloor()).toEqual({ floorSol: 0, priceSol: 0 });
		expect(normalizeFloor({ floorSol: 'abc', priceSol: Infinity })).toEqual({ floorSol: 0, priceSol: 0 });
	});
	it('coerces numeric strings', () => {
		expect(normalizeFloor({ floorSol: '0.5', priceSol: '0.75' })).toEqual({ floorSol: 0.5, priceSol: 0.75 });
	});
});

describe('formatting', () => {
	it('fmtSizeSol adapts precision by magnitude', () => {
		expect(fmtSizeSol(0.4)).toBe('0.40');
		expect(fmtSizeSol(1.5)).toBe('1.50');
		expect(fmtSizeSol(0.024)).toBe('0.024');
		expect(fmtSizeSol(0.0015)).toBe('0.0015');
		expect(fmtSizeSol(0)).toBe('0');
		expect(fmtSizeSol(NaN)).toBe('0');
	});
	it('fmtPriceSol keeps ~3 significant figures on tiny prices', () => {
		expect(fmtPriceSol(0.0000142)).toBe('0.0000142');
		expect(fmtPriceSol(0)).toBe('0');
		expect(fmtPriceSol(1.42)).toBe('1.4200');
		// no NaN / exponent leaks into a holder-facing string
		expect(fmtPriceSol(-5)).toBe('0');
	});
});

describe('mmSummary — holder-readable lines', () => {
	it('writes the canonical defend line', () => {
		expect(mmSummary({ actionType: 'mm_defend', sizeSol: 0.4, priceSol: 0.0000142 }))
			.toBe('Defended floor: bought 0.40 SOL at 0.0000142');
	});
	it('tags simulate fills', () => {
		expect(mmSummary({ actionType: 'mm_defend', sizeSol: 0.4, priceSol: 0.0000142, simulate: true }))
			.toBe('Defended floor: bought 0.40 SOL at 0.0000142 (sim)');
	});
	it('covers every action_type', () => {
		for (const t of MM_ACTION_TYPES) {
			const s = mmSummary({ actionType: t, sizeSol: 0.4, priceSol: 0.00001, floorSol: 0.00001 });
			expect(typeof s).toBe('string');
			expect(s.length).toBeGreaterThan(0);
		}
	});
});

describe('mmEventFromOutcome — outcome → persisted/published event', () => {
	const baseOutcome = {
		tag: 'defend_buy',
		mint: 'THREEsynthetic1111111111111111111111111111111',
		floorSol: 0.0000142,
		priceSol: 0.0000138,
		sizeSol: 0.4,
		sideBuy: true,
		signature: 'sig_live_abc',
		simulate: false,
	};

	it('builds the full event with normalized context', () => {
		const ev = mmEventFromOutcome(baseOutcome);
		expect(ev.actionType).toBe('mm_defend');
		expect(ev.summary).toBe('Defended floor: bought 0.40 SOL at 0.0000138');
		expect(ev.context).toEqual({
			mint: 'THREEsynthetic1111111111111111111111111111111',
			floorSol: 0.0000142,
			priceSol: 0.0000138,
			sizeSol: 0.4,
			sideBuy: true,
			simulate: false,
			signature: 'sig_live_abc',
		});
	});

	it('drops the SIMULATED sentinel signature and tags the summary', () => {
		const ev = mmEventFromOutcome({ ...baseOutcome, signature: 'SIMULATED', simulate: true });
		expect(ev.context.signature).toBeNull();
		expect(ev.context.simulate).toBe(true);
		expect(ev.summary.endsWith('(sim)')).toBe(true);
	});

	it('normalizes garbage numbers + non-string mint without throwing', () => {
		const ev = mmEventFromOutcome({ tag: 'in_band', mint: 12345, floorSol: NaN, priceSol: -2, sizeSol: 'x' });
		expect(ev.actionType).toBe('mm_quote');
		expect(ev.context.mint).toBeNull();
		expect(ev.context.floorSol).toBe(0);
		expect(ev.context.priceSol).toBe(0);
		expect(ev.context.sizeSol).toBe(0);
		expect(ev.context.sideBuy).toBeNull();
	});

	it('handles an empty outcome', () => {
		const ev = mmEventFromOutcome();
		expect(ev.actionType).toBe('mm_quote');
		expect(ev.context.floorSol).toBe(0);
	});
});

describe('sanitizeMmEvent — inbound ride-along whitelist', () => {
	it('round-trips a clean event', () => {
		const out = sanitizeMmEvent({ type: 'mm_defend', floorSol: 0.01, priceSol: 0.009, sizeSol: 0.5, sideBuy: true, simulate: false, mint: 'm', signature: 's' });
		expect(out).toEqual({ type: 'mm_defend', floorSol: 0.01, priceSol: 0.009, sizeSol: 0.5, sideBuy: true, simulate: false, mint: 'm', signature: 's' });
	});
	it('defaults an unknown type to mm_quote and clamps numbers', () => {
		const out = sanitizeMmEvent({ type: 'evil', floorSol: -1, priceSol: NaN, sizeSol: 9 });
		expect(out.type).toBe('mm_quote');
		expect(out.floorSol).toBe(0);
		expect(out.priceSol).toBe(0);
		expect(out.sizeSol).toBe(9);
	});
	it('rejects unusable payloads', () => {
		expect(sanitizeMmEvent(null)).toBeNull();
		expect(sanitizeMmEvent('nope')).toBeNull();
		expect(sanitizeMmEvent(42)).toBeNull();
	});
	it('bounds long strings', () => {
		const out = sanitizeMmEvent({ type: 'mm_quote', mint: 'x'.repeat(200), signature: 'y'.repeat(200) });
		expect(out.mint.length).toBe(64);
		expect(out.signature.length).toBe(96);
	});
});

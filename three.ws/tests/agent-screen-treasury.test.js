// Treasury cockpit — pure presentation helpers.
//
// The runway-gauge math, number formatters, and policy-line wording are the only
// logic in the cockpit that can be wrong in a way the eye won't catch, so they get
// real coverage here. Everything tested is side-effect-free (no DOM, no network).

import { describe, it, expect } from 'vitest';
import {
	fmtUsd,
	fmtSol,
	fmtCompact,
	runwayGauge,
	arcDash,
	policyLine,
	isTreasuryActivity,
	actionToast,
} from '../src/agent-screen-treasury-format.js';

describe('fmtUsd', () => {
	it('shows cents under $1k and whole dollars above', () => {
		expect(fmtUsd(12.5)).toBe('$12.50');
		expect(fmtUsd(0.182)).toBe('$0.182');
		expect(fmtUsd(2480)).toBe('$2,480');
		expect(fmtUsd(0)).toBe('$0.00');
	});
	it('compacts large values when asked', () => {
		expect(fmtUsd(1_500_000, { compact: true })).toBe('$1.50M');
		expect(fmtUsd(24_000, { compact: true })).toBe('$24.0k');
	});
	it('handles negatives and junk', () => {
		expect(fmtUsd(-50)).toBe('-$50.00');
		expect(fmtUsd(null)).toBe('—');
		expect(fmtUsd(Infinity)).toBe('—');
	});
});

describe('fmtSol / fmtCompact', () => {
	it('trims trailing zeros on SOL', () => {
		expect(fmtSol(1.5)).toBe('1.5 SOL');
		expect(fmtSol(2)).toBe('2 SOL');
		expect(fmtSol(0.18000001)).toBe('0.18 SOL');
		expect(fmtSol(null)).toBe('—');
	});
	it('compacts token counts', () => {
		expect(fmtCompact(412_000)).toBe('412K');
		expect(fmtCompact(1_240_000)).toBe('1.24M');
		expect(fmtCompact(950)).toBe('950');
		expect(fmtCompact(null)).toBe('—');
	});
});

describe('runwayGauge', () => {
	it('renders a full healthy arc when self-sustaining', () => {
		const g = runwayGauge({ self_sustaining: true, price_usd: 150, balance_usd: 100 });
		expect(g.infinite).toBe(true);
		expect(g.fraction).toBe(1);
		expect(g.tone).toBe('sustain');
		expect(g.label).toBe('∞');
	});
	it('reports unknown (not infinite) when the price feed is down', () => {
		const g = runwayGauge({ self_sustaining: false, price_usd: null, balance_usd: null, runway_days: null });
		expect(g.unknown).toBe(true);
		expect(g.infinite).toBe(false);
		expect(g.tone).toBe('unknown');
		expect(g.fraction).toBe(0);
		expect(g.label).toBe('—');
	});
	it('scales a finite runway against the horizon and tones by urgency', () => {
		const base = { self_sustaining: false, price_usd: 150, balance_usd: 100 };
		expect(runwayGauge({ ...base, runway_days: 45 }).fraction).toBeCloseTo(0.5, 5);
		expect(runwayGauge({ ...base, runway_days: 45 }).tone).toBe('healthy');
		expect(runwayGauge({ ...base, runway_days: 14 }).tone).toBe('warn');
		expect(runwayGauge({ ...base, runway_days: 3 }).tone).toBe('critical');
		expect(runwayGauge({ ...base, runway_days: 0.5 }).label).toBe('<1d');
	});
	it('clamps a runway beyond the horizon to a full arc', () => {
		const g = runwayGauge({ self_sustaining: false, price_usd: 150, balance_usd: 100, runway_days: 400 });
		expect(g.fraction).toBe(1);
		expect(g.label).toBe('400d');
	});
});

describe('arcDash', () => {
	it('fills the stroke proportionally and clamps', () => {
		const C = 100;
		expect(arcDash(0.25, C).dash).toBe('25 100');
		expect(arcDash(2, C).dash).toBe('100 100');
		expect(arcDash(-1, C).dash).toBe('0 100');
	});
});

describe('policyLine', () => {
	it('formats an armed rule with its glyph and label', () => {
		const l = policyLine({ kind: 'buyback', label: 'Compound 100% of coin fees into buybacks (weekly)', enabled: true });
		expect(l.state).toBe('armed');
		expect(l.stateLabel).toBe('Armed');
		expect(l.glyph).toBe('🔥');
		expect(l.text).toContain('buybacks');
	});
	it('marks paused and disabled rules', () => {
		expect(policyLine({ kind: 'dca', paused: true }).state).toBe('paused');
		expect(policyLine({ kind: 'dca', enabled: false }).state).toBe('off');
	});
	it('surfaces the last run status when present', () => {
		const l = policyLine({ kind: 'sweep', enabled: true, last_status: 'ok', last_note: 'sent 0.4 SOL' });
		expect(l.lastStatus).toBe('ok');
		expect(l.note).toBe('sent 0.4 SOL');
	});
});

describe('isTreasuryActivity', () => {
	it('matches real autopilot movements', () => {
		expect(isTreasuryActivity('Bought back 412,000 $THREE for 0.18 SOL')).toBe(true);
		expect(isTreasuryActivity('Distributed fees to holders')).toBe(true);
		expect(isTreasuryActivity('Swept 0.5 SOL to owner')).toBe(true);
		expect(isTreasuryActivity('DCA into $THREE')).toBe(true);
	});
	it('ignores unrelated chatter', () => {
		expect(isTreasuryActivity('Opened a browser tab')).toBe(false);
		expect(isTreasuryActivity('')).toBe(false);
		expect(isTreasuryActivity(null)).toBe(false);
	});
});

describe('actionToast', () => {
	it('phrases a settled buyback with its USD value', () => {
		expect(actionToast({ kind: 'buyback', last_status: 'ok', usd: 18.4 })).toBe('Bought back $THREE — $18.40');
	});
	it('reports a non-ok result with its note', () => {
		expect(actionToast({ kind: 'dca', last_status: 'paused', last_note: 'below buffer' })).toBe('Bought $THREE: below buffer');
	});
});

// Oracle exit-signal engine — the rules that close an open position. Pinned hard,
// because getting OUT is the half of a strategy the entry loop never covered.

import { describe, it, expect } from 'vitest';
import { evaluateExit, DEFAULT_EXIT_CFG } from '../../api/_lib/oracle/exit.js';

const held = { entryConviction: 82, entryTier: 'strong' };

describe('evaluateExit', () => {
	it('holds while the thesis is intact', () => {
		const d = evaluateExit({ position: held, current: { score: 80, tier: 'strong', badges: [] } });
		expect(d.exit).toBe(false);
		expect(d.urgency).toBe('none');
		expect(d.reason).toMatch(/hold/);
	});

	it('takes profit at the target multiple', () => {
		const d = evaluateExit({ position: held, current: { score: 80, multiple: 3.4 } });
		expect(d.exit).toBe(true);
		expect(d.trigger).toBe('take_profit');
		expect(d.reason).toMatch(/3\.4×/);
	});

	it('honors an opt-in hard stop and stays dormant when disabled', () => {
		const withStop = evaluateExit({ position: held, current: { score: 80, multiple: 0.4 }, cfg: { stopLossMultiple: 0.5 } });
		expect(withStop.exit).toBe(true);
		expect(withStop.trigger).toBe('stop_loss');
		expect(withStop.urgency).toBe('high');
		// Default cfg disables the stop (stopLossMultiple 0) — a drawdown alone won't fire it.
		const noStop = evaluateExit({ position: held, current: { score: 80, multiple: 0.4 } });
		expect(noStop.exit).toBe(false);
	});

	it('bails when a red flag surfaces after entry', () => {
		const structural = evaluateExit({ position: held, current: { score: 78, badges: ['structure-flag'] } });
		expect(structural.trigger).toBe('red_flag');
		expect(structural.urgency).toBe('high');
		const creator = evaluateExit({ position: held, current: { score: 78, badges: ['pedigree-flag'] } });
		expect(creator.trigger).toBe('red_flag');
		expect(creator.reason).toMatch(/creator/);
	});

	it('exits when smart money is unwinding', () => {
		const d = evaluateExit({ position: held, current: { score: 75, smartMoneyExiting: true } });
		expect(d.exit).toBe(true);
		expect(d.trigger).toBe('smart_money_exit');
	});

	it('exits on a conviction collapse below the floor', () => {
		const d = evaluateExit({ position: held, current: { score: 40 } });
		expect(d.exit).toBe(true);
		expect(d.trigger).toBe('conviction_collapse');
	});

	it('exits on a large conviction drop even above the floor', () => {
		const d = evaluateExit({ position: { entryConviction: 90 }, current: { score: 65 } }); // -25 pts
		expect(d.exit).toBe(true);
		expect(d.trigger).toBe('conviction_drop');
	});

	it('take-profit outranks a simultaneous red flag (realize the win first)', () => {
		const d = evaluateExit({ position: held, current: { score: 40, multiple: 5, badges: ['structure-flag'] } });
		expect(d.trigger).toBe('take_profit');
	});

	it('tolerates empty input and exposes a conservative default policy', () => {
		expect(() => evaluateExit()).not.toThrow();
		expect(evaluateExit().exit).toBe(false);
		expect(DEFAULT_EXIT_CFG.takeProfitMultiple).toBeGreaterThan(0);
		expect(DEFAULT_EXIT_CFG.stopLossMultiple).toBe(0);
	});
});

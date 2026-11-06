/**
 * Copy-trading performance-fee math — high-water-mark correctness.
 * Money-adjacent: the HWM must never double-bill a recovery, never bill a loss.
 */

import { describe, it, expect } from 'vitest';
import { computePerfFee } from '../api/_lib/copy-earnings.js';

describe('computePerfFee', () => {
	it('bills the leader fee on first profit and ratchets the HWM', () => {
		const r = computePerfFee({ realizedProfitSol: 10, highWaterMarkSol: 0, feeBps: 1000 });
		expect(r.billable_profit_sol).toBe(10);
		expect(r.fee_sol).toBeCloseTo(1, 6); // 10% of 10
		expect(r.new_high_water_mark_sol).toBe(10);
	});

	it('charges nothing on a drawdown below the HWM and keeps the HWM', () => {
		const r = computePerfFee({ realizedProfitSol: 8, highWaterMarkSol: 10, feeBps: 1000 });
		expect(r.billable_profit_sol).toBe(0);
		expect(r.fee_sol).toBe(0);
		expect(r.new_high_water_mark_sol).toBe(10);
	});

	it('only bills NEW profit above the prior peak after a recovery', () => {
		const r = computePerfFee({ realizedProfitSol: 15, highWaterMarkSol: 10, feeBps: 1000 });
		expect(r.billable_profit_sol).toBe(5); // not the full 15
		expect(r.fee_sol).toBeCloseTo(0.5, 6);
		expect(r.new_high_water_mark_sol).toBe(15);
	});

	it('never bills a net loss', () => {
		const r = computePerfFee({ realizedProfitSol: -4, highWaterMarkSol: 0, feeBps: 1000 });
		expect(r.fee_sol).toBe(0);
		expect(r.billable_profit_sol).toBe(0);
		expect(r.new_high_water_mark_sol).toBe(0); // a loss never lowers the HWM
	});

	it('honors the leader fee rate', () => {
		expect(computePerfFee({ realizedProfitSol: 100, highWaterMarkSol: 0, feeBps: 2000 }).fee_sol).toBeCloseTo(20, 6);
		expect(computePerfFee({ realizedProfitSol: 100, highWaterMarkSol: 0, feeBps: 0 }).fee_sol).toBe(0);
	});

	it('is sequence-correct across draw-down then recovery (no double billing)', () => {
		// peak 10 (billed) → dip to 8 (no bill) → recover to 15 (bill only the +5)
		let hwm = 0, totalFee = 0;
		for (const cum of [10, 8, 15]) {
			const r = computePerfFee({ realizedProfitSol: cum, highWaterMarkSol: hwm, feeBps: 1000 });
			totalFee += r.fee_sol;
			hwm = r.new_high_water_mark_sol;
		}
		// fees: 1.0 (on 10) + 0 (dip) + 0.5 (on +5) = 1.5 — the same as billing 15 once.
		expect(totalFee).toBeCloseTo(1.5, 6);
		expect(hwm).toBe(15);
	});
});

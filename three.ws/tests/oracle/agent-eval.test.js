// Oracle agent-eval — the rules that gate real money. Pinned hard.

import { describe, it, expect } from 'vitest';
import { evaluateWatch } from '../../api/_lib/oracle/agent-eval.js';

const baseWatch = {
	armed: true, mode: 'simulate', min_score: 72, min_tier: 'strong',
	categories: [], per_trade_sol: 0.05, max_daily_sol: 0.5, max_open: 5, require_smart_money: true,
};
const goodCoin = { score: 88, tier: 'prime', category: 'ai', smart_wallet_count: 3 };

describe('evaluateWatch', () => {
	it('acts on a coin that clears every gate', () => {
		const d = evaluateWatch({ watch: baseWatch, coin: goodCoin, openCount: 0, spentTodaySol: 0 });
		expect(d.act).toBe(true);
		expect(d.size).toBe(0.05);
	});

	it('never acts when not armed', () => {
		expect(evaluateWatch({ watch: { ...baseWatch, armed: false }, coin: goodCoin }).act).toBe(false);
	});

	it('blocks below the score threshold', () => {
		const d = evaluateWatch({ watch: baseWatch, coin: { ...goodCoin, score: 60, tier: 'lean' } });
		expect(d.act).toBe(false);
		expect(d.reason).toMatch(/below threshold/);
	});

	it('blocks below the tier floor even if score sneaks through', () => {
		const d = evaluateWatch({ watch: { ...baseWatch, min_score: 0, min_tier: 'strong' }, coin: { ...goodCoin, tier: 'watch' } });
		expect(d.act).toBe(false);
		expect(d.reason).toMatch(/tier/);
	});

	it('blocks a thin-data coin by default and honors the opt-in', () => {
		const thin = { ...goodCoin, badges: ['smart-money', 'thin-data'] };
		expect(evaluateWatch({ watch: baseWatch, coin: thin }).act).toBe(false);
		expect(evaluateWatch({ watch: baseWatch, coin: thin }).reason).toMatch(/thin data/);
		expect(evaluateWatch({ watch: { ...baseWatch, allow_thin_data: true }, coin: thin }).act).toBe(true);
	});

	it('honors an explicit numeric confidence floor', () => {
		const w = { ...baseWatch, min_confidence: 60 };
		expect(evaluateWatch({ watch: w, coin: { ...goodCoin, confidence: 40 } }).act).toBe(false);
		expect(evaluateWatch({ watch: w, coin: { ...goodCoin, confidence: 80 } }).act).toBe(true);
		// Absent confidence should not block (backward-compatible).
		expect(evaluateWatch({ watch: w, coin: goodCoin }).act).toBe(true);
	});

	it('respects the narrative watchlist', () => {
		const only = { ...baseWatch, categories: ['news', 'culture'] };
		expect(evaluateWatch({ watch: only, coin: goodCoin }).act).toBe(false);
		expect(evaluateWatch({ watch: only, coin: { ...goodCoin, category: 'news' } }).act).toBe(true);
	});

	it('requires smart money when configured', () => {
		expect(evaluateWatch({ watch: baseWatch, coin: { ...goodCoin, smart_wallet_count: 0 } }).act).toBe(false);
		expect(evaluateWatch({ watch: { ...baseWatch, require_smart_money: false }, coin: { ...goodCoin, smart_wallet_count: 0 } }).act).toBe(true);
	});

	it('enforces the open-position cap', () => {
		const d = evaluateWatch({ watch: baseWatch, coin: goodCoin, openCount: 5 });
		expect(d.act).toBe(false);
		expect(d.reason).toMatch(/max open/);
	});

	it('enforces the daily budget', () => {
		const d = evaluateWatch({ watch: baseWatch, coin: goodCoin, openCount: 0, spentTodaySol: 0.48 });
		expect(d.act).toBe(false);
		expect(d.reason).toMatch(/daily budget/);
	});

	it('allows the exact last trade that fits the budget', () => {
		const d = evaluateWatch({ watch: baseWatch, coin: goodCoin, openCount: 0, spentTodaySol: 0.45 });
		expect(d.act).toBe(true);
	});

	describe('size_scaling', () => {
		const scalingWatch = { ...baseWatch, size_scaling: true, min_score: 72, per_trade_sol: 0.1 };

		it('returns base size at the minimum score', () => {
			const d = evaluateWatch({ watch: scalingWatch, coin: { ...goodCoin, score: 72 } });
			expect(d.act).toBe(true);
			expect(d.size).toBe(0.1); // 1.0× at min score
		});

		it('returns 1.5× base at score 100', () => {
			const d = evaluateWatch({ watch: scalingWatch, coin: { ...goodCoin, score: 100 } });
			expect(d.act).toBe(true);
			expect(d.size).toBeCloseTo(0.15, 4); // 1.5× at max
		});

		it('scales proportionally in the middle', () => {
			// score 86 is (86-72)/(100-72) = 14/28 = 0.5 of the range → 1.25×
			const d = evaluateWatch({ watch: scalingWatch, coin: { ...goodCoin, score: 86 } });
			expect(d.act).toBe(true);
			expect(d.size).toBeCloseTo(0.125, 4);
		});

		it('does not scale when size_scaling is false', () => {
			const d = evaluateWatch({ watch: { ...scalingWatch, size_scaling: false }, coin: { ...goodCoin, score: 100 } });
			expect(d.act).toBe(true);
			expect(d.size).toBe(0.1); // no scaling
		});

		it('blocks when scaled size would exceed daily budget', () => {
			// base 0.1 × 1.5 = 0.15; spent 0.45 + 0.15 = 0.60 > 0.5 max
			const d = evaluateWatch({ watch: scalingWatch, coin: { ...goodCoin, score: 100 }, openCount: 0, spentTodaySol: 0.45 });
			expect(d.act).toBe(false);
			expect(d.reason).toMatch(/daily budget/);
		});
	});
});

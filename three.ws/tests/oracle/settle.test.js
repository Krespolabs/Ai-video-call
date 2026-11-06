// Oracle settle — grading & summary. The honest win-rate record depends on this.

import { describe, it, expect } from 'vitest';
import { gradeAction, summarizeActions } from '../../api/_lib/oracle/settle.js';

describe('gradeAction', () => {
	it('stays open with no outcome row', () => {
		expect(gradeAction({ size_sol: 0.05 }, null).outcome).toBe('open');
	});

	it('stays open when the outcome row carries no resolved signal', () => {
		const g = gradeAction({ size_sol: 0.05, entry_mc_usd: 10000 }, { graduated: false, rugged: false, ath_multiple: null, last_market_cap_usd: null });
		expect(g.settled).toBe(false);
		expect(g.outcome).toBe('open');
	});

	it('grades a graduation as a win', () => {
		const g = gradeAction({ size_sol: 0.1, entry_mc_usd: 10000 }, { graduated: true, ath_multiple: 8, last_market_cap_usd: 60000 });
		expect(g.outcome).toBe('win');
		expect(g.peak_multiple).toBe(8);
		expect(g.realized_pnl_sol).toBeCloseTo(0.1 * (6 - 1), 5); // last/entry = 6
	});

	it('grades a high ATH multiple as a win even without graduation', () => {
		expect(gradeAction({ size_sol: 0.05 }, { graduated: false, ath_multiple: 3 }).outcome).toBe('win');
	});

	it('grades a rug as a loss', () => {
		expect(gradeAction({ size_sol: 0.05, entry_mc_usd: 10000 }, { rugged: true, last_market_cap_usd: 1000 }).outcome).toBe('loss');
	});

	it('grades a deep markdown as a loss', () => {
		expect(gradeAction({ size_sol: 0.05, entry_mc_usd: 10000 }, { ath_multiple: 1.1, last_market_cap_usd: 3000 }).outcome).toBe('loss');
	});

	it('a 2×+ spike that then rugged is a loss, not a win', () => {
		// The peak was exit liquidity — nobody systematically sells the wick.
		const g = gradeAction({ size_sol: 0.05, entry_mc_usd: 10000 }, { graduated: false, rugged: true, ath_multiple: 3, last_market_cap_usd: 500 });
		expect(g.outcome).toBe('loss');
	});

	it('a 2×+ peak with the position now marked below half entry is a loss', () => {
		const g = gradeAction({ size_sol: 0.05, entry_mc_usd: 10000 }, { graduated: false, rugged: false, ath_multiple: 2.5, last_market_cap_usd: 3000 });
		expect(g.outcome).toBe('loss'); // mark = 0.3
	});

	it('graduation still wins even if the pump.fun mark later faded', () => {
		const g = gradeAction({ size_sol: 0.05, entry_mc_usd: 10000 }, { graduated: true, rugged: false, ath_multiple: 4, last_market_cap_usd: 4000 });
		expect(g.outcome).toBe('win'); // graduated coins trade on a real market post-bond
	});

	it('computes honest mark-to-market PnL from entry vs last', () => {
		const g = gradeAction({ size_sol: 1, entry_mc_usd: 10000 }, { graduated: true, ath_multiple: 2, last_market_cap_usd: 5000 });
		expect(g.realized_pnl_sol).toBeCloseTo(-0.5, 5); // halved
	});
});

describe('summarizeActions', () => {
	it('rolls wins/losses into a win rate and ROI', () => {
		const s = summarizeActions([
			{ outcome: 'win', realized_pnl_sol: 0.5, size_sol: 0.1 },
			{ outcome: 'win', realized_pnl_sol: 0.2, size_sol: 0.1 },
			{ outcome: 'loss', realized_pnl_sol: -0.1, size_sol: 0.1 },
			{ outcome: 'open', realized_pnl_sol: null, size_sol: 0.1 },
		]);
		expect(s.wins).toBe(2);
		expect(s.losses).toBe(1);
		expect(s.open).toBe(1);
		expect(s.win_rate).toBe(67); // 2/3
		expect(s.realized_pnl_sol).toBeCloseTo(0.6, 5);
		expect(s.roi_pct).toBe(150); // 0.6 / 0.4
	});

	it('handles an empty ledger', () => {
		const s = summarizeActions([]);
		expect(s.total).toBe(0);
		expect(s.win_rate).toBeNull();
	});
});

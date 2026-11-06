// Pulse "Trading viability" — the money math behind GET /api/pulse?view=trading.
//
// The panel and any agent client lean on two guarantees these tests pin:
//   1. A window's `trades` is a pass-through of the headline COUNT, so the panel
//      can never silently drift from the number at the top of /pulse.
//   2. SOL is always lamports/1e9, and the average trade amortises real deployed
//      SOL over the BUY count (sells carry no SOL out), never over total trades.

import { describe, it, expect } from 'vitest';
import {
	solFromLamports,
	shapeTradingWindow,
	shapeTradingPnl,
	shapeTradingSeries,
} from '../api/_lib/pulse-trading.js';

describe('solFromLamports', () => {
	it('converts lamports (string or number) to SOL', () => {
		expect(solFromLamports('1000000000')).toBe(1);
		expect(solFromLamports(500_000_000)).toBe(0.5);
	});
	it('treats null/undefined/empty as zero', () => {
		expect(solFromLamports(null)).toBe(0);
		expect(solFromLamports(undefined)).toBe(0);
		expect(solFromLamports('0')).toBe(0);
	});
});

describe('shapeTradingWindow', () => {
	it('passes trade count straight through (reconciles with the headline counter)', () => {
		const row = { trades: 42, buys: 30, sells: 12, deployed_lamports: '340000000', deployed_usd: 24.5, traders: 9 };
		expect(shapeTradingWindow(row).trades).toBe(42);
	});

	it('derives deployed SOL and averages it over BUYS, not total trades', () => {
		// 0.34 SOL across 30 buys (12 of the 42 trades were sells with no SOL out).
		const w = shapeTradingWindow({ trades: 42, buys: 30, sells: 12, deployed_lamports: '340000000', deployed_usd: 24.5, traders: 9 });
		expect(w.deployed_sol).toBeCloseTo(0.34, 9);
		expect(w.avg_trade_sol).toBeCloseTo(0.34 / 30, 9);
		expect(w.sells).toBe(12);
		expect(w.traders).toBe(9);
	});

	it('avg trade is 0 (never NaN/Infinity) when there are no buys', () => {
		const w = shapeTradingWindow({ trades: 3, buys: 0, sells: 3, deployed_lamports: '0' });
		expect(w.avg_trade_sol).toBe(0);
		expect(Number.isFinite(w.avg_trade_sol)).toBe(true);
	});

	it('defaults every field to a safe zero for an empty/missing row', () => {
		for (const empty of [undefined, null, {}]) {
			const w = shapeTradingWindow(empty);
			expect(w).toMatchObject({ trades: 0, buys: 0, sells: 0, deployed_sol: 0, deployed_usd: 0, traders: 0, avg_trade_sol: 0 });
		}
	});
});

describe('shapeTradingPnl', () => {
	it('keeps the signed net (a loss stays negative) and computes the win rate', () => {
		const p = shapeTradingPnl({ closed_count: 11, wins: 7, net_lamports: '52000000' });
		expect(p.net_sol).toBeCloseTo(0.052, 9);
		expect(p.closed_positions).toBe(11);
		expect(p.win_rate).toBeCloseTo(7 / 11, 9);
	});

	it('preserves a negative net P&L (loss) rather than clamping it', () => {
		const p = shapeTradingPnl({ closed_count: 4, wins: 1, net_lamports: '-30000000' });
		expect(p.net_sol).toBeCloseTo(-0.03, 9);
		expect(p.win_rate).toBeCloseTo(0.25, 9);
	});

	it('win_rate is null (not 0) when nothing has closed — drives the honest empty state', () => {
		const p = shapeTradingPnl({ closed_count: 0, wins: 0, net_lamports: '0' });
		expect(p.win_rate).toBeNull();
		expect(p.closed_positions).toBe(0);
		expect(p.net_sol).toBe(0);
	});
});

describe('shapeTradingSeries', () => {
	it('maps daily rows to sparkline points with SOL-converted deploy', () => {
		const out = shapeTradingSeries([
			{ label: 'Mon', day: '2026-06-22', trades: 12, deployed_lamports: '100000000' },
			{ label: 'Tue', day: '2026-06-23', trades: 40, deployed_lamports: '300000000' },
		]);
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({ label: 'Mon', day: '2026-06-22', trades: 12, deployed_sol: 0.1 });
		expect(out[1].deployed_sol).toBeCloseTo(0.3, 9);
	});

	it('returns [] for null/undefined input', () => {
		expect(shapeTradingSeries(null)).toEqual([]);
		expect(shapeTradingSeries(undefined)).toEqual([]);
	});
});

import { describe, it, expect } from 'vitest';
import {
	buildSniperAnalytics,
	classifySniperSignal,
	WIN_RATE_ALERT_THRESHOLD,
	MIN_ALERT_SAMPLE,
	LAMPORTS_PER_SOL,
} from '../api/_lib/x402/sniper-analytics-store.js';

// Real aggregate row shapes from agent_sniper_positions (lamport values as strings,
// matching what postgres/node-postgres returns for numeric(40,0) columns).
const WINNING_AGG = {
	closed: '10',
	wins: '7',
	losses: '3',
	breakeven: '0',
	volume_lamports: String(5 * LAMPORTS_PER_SOL),   // 5 SOL in
	total_pnl_lamports: String(0.5 * LAMPORTS_PER_SOL), // +0.5 SOL profit
	avg_pnl_lamports: String(0.05 * LAMPORTS_PER_SOL),
	worst_loss_lamports: String(-0.1 * LAMPORTS_PER_SOL),
	best_win_lamports: String(0.3 * LAMPORTS_PER_SOL),
	avg_pnl_pct: '10',
};

const LOSING_AGG = {
	closed: '8',
	wins: '2',
	losses: '6',
	breakeven: '0',
	volume_lamports: String(4 * LAMPORTS_PER_SOL),
	total_pnl_lamports: String(-0.4 * LAMPORTS_PER_SOL),
	avg_pnl_lamports: String(-0.05 * LAMPORTS_PER_SOL),
	worst_loss_lamports: String(-0.15 * LAMPORTS_PER_SOL),
	best_win_lamports: String(0.08 * LAMPORTS_PER_SOL),
	avg_pnl_pct: '-10',
};

const EMPTY_AGG = {
	closed: '0', wins: '0', losses: '0', breakeven: '0',
	volume_lamports: '0', total_pnl_lamports: '0', avg_pnl_lamports: '0',
	worst_loss_lamports: '0', best_win_lamports: '0', avg_pnl_pct: '0',
};

describe('buildSniperAnalytics', () => {
	it('computes win rate correctly', () => {
		const r = buildSniperAnalytics(WINNING_AGG, { period: '24h', network: 'mainnet', report: 'sniper_trades' });
		expect(r.wins).toBe(7);
		expect(r.losses).toBe(3);
		expect(r.sample_size).toBe(10);
		expect(r.win_rate).toBeCloseTo(0.7, 4);
		expect(r.win_rate_pct).toBeCloseTo(70, 2);
	});

	it('converts lamports to SOL', () => {
		const r = buildSniperAnalytics(WINNING_AGG, { period: '24h', network: 'mainnet', report: 'sniper_trades' });
		expect(r.total_volume_sol).toBeCloseTo(5, 6);
		expect(r.avg_profit_sol).toBeCloseTo(0.05, 6);
		expect(r.worst_loss_sol).toBeCloseTo(-0.1, 6);
	});

	it('converts to USDC when solUsd is supplied', () => {
		const r = buildSniperAnalytics(WINNING_AGG, { solUsd: 148, period: '24h', network: 'mainnet', report: 'sniper_trades' });
		expect(r.total_volume_usdc).toBeCloseTo(5 * 148, 1);
		expect(r.avg_profit_usdc).toBeCloseTo(0.05 * 148, 2);
	});

	it('leaves USD fields null when solUsd is absent', () => {
		const r = buildSniperAnalytics(WINNING_AGG, { solUsd: null, period: '24h', network: 'mainnet', report: 'sniper_trades' });
		expect(r.total_volume_usdc).toBeNull();
		expect(r.avg_profit_usdc).toBeNull();
	});

	it('does NOT fire alert when win rate >= threshold', () => {
		const r = buildSniperAnalytics(WINNING_AGG, { period: '24h', network: 'mainnet', report: 'sniper_trades' });
		expect(r.alert).toBeNull();
	});

	it('fires low_win_rate alert when below threshold and sample >= MIN_ALERT_SAMPLE', () => {
		const r = buildSniperAnalytics(LOSING_AGG, { period: '24h', network: 'mainnet', report: 'sniper_trades' });
		expect(LOSING_AGG.wins / LOSING_AGG.closed).toBeLessThan(WIN_RATE_ALERT_THRESHOLD);
		expect(Number(LOSING_AGG.closed)).toBeGreaterThanOrEqual(MIN_ALERT_SAMPLE);
		expect(r.alert).not.toBeNull();
		expect(r.alert.type).toBe('low_win_rate');
		expect(r.alert.sample_size).toBe(8);
	});

	it('suppresses alert when sample is too small', () => {
		const smallSample = { ...LOSING_AGG, closed: '3', wins: '0', losses: '3' };
		const r = buildSniperAnalytics(smallSample, { period: '24h', network: 'mainnet', report: 'sniper_trades' });
		expect(r.alert).toBeNull();
	});

	it('returns zeros (not NaN) on empty agg', () => {
		const r = buildSniperAnalytics(EMPTY_AGG, { period: '24h', network: 'mainnet', report: 'sniper_trades' });
		expect(r.sample_size).toBe(0);
		expect(r.win_rate).toBe(0);
		expect(r.total_volume_sol).toBe(0);
		expect(r.alert).toBeNull();
	});

	it('echoes report, period, network', () => {
		const r = buildSniperAnalytics(WINNING_AGG, { period: '7d', network: 'devnet', report: 'sniper_trades', generatedAt: '2026-06-28T00:00:00.000Z' });
		expect(r.report).toBe('sniper_trades');
		expect(r.period).toBe('7d');
		expect(r.network).toBe('devnet');
		expect(r.generated_at).toBe('2026-06-28T00:00:00.000Z');
	});
});

describe('classifySniperSignal', () => {
	it('lifts headline metrics from a full report', () => {
		const report = buildSniperAnalytics(WINNING_AGG, { solUsd: 148, period: '24h', network: 'mainnet', report: 'sniper_trades' });
		const sig = classifySniperSignal(report);
		expect(sig.win_rate).toBeCloseTo(0.7, 4);
		expect(sig.avg_profit_usdc).toBeCloseTo(0.05 * 148, 2);
		expect(sig.total_volume_sol).toBeCloseTo(5, 6);
		expect(sig.sample_size).toBe(10);
		expect(sig.alert).toBeNull();
		expect(sig.report).toBe('sniper_trades');
		expect(sig.period).toBe('24h');
	});

	it('lifts alert when present', () => {
		const report = buildSniperAnalytics(LOSING_AGG, { period: '24h', network: 'mainnet', report: 'sniper_trades' });
		const sig = classifySniperSignal(report);
		expect(sig.alert).not.toBeNull();
		expect(sig.alert.type).toBe('low_win_rate');
	});

	it('handles null / missing response gracefully', () => {
		const sig = classifySniperSignal(null);
		expect(sig.win_rate).toBeNull();
		expect(sig.sample_size).toBeNull();
	});
});

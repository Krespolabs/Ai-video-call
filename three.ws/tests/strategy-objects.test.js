/**
 * Strategy Objects — pure rule-engine tests.
 *
 * Money-adjacent: a strategy's config is the leash the autonomous runtime trades
 * against, so every bound, every entry gate, and every exit trigger is pinned here.
 * The same functions run in the live cron runtime and in any backtest, so locking
 * them down locks down both. No DB, no chain — pure logic only.
 */

import { describe, it, expect } from 'vitest';
import {
	validateStrategyConfig,
	normalizeStrategyConfig,
	matchesEntry,
	shouldExit,
	slugifyStrategy,
	STRATEGY_CONFIG_DEFAULTS,
} from '../api/_lib/strategy-schema.js';

const NOW = 1_700_000_000_000; // fixed epoch ms so age math is deterministic
const minsAgo = (m) => NOW - m * 60_000;

describe('normalizeStrategyConfig', () => {
	it('fills a complete config from empty input (every key present)', () => {
		const c = normalizeStrategyConfig({});
		expect(c.network).toBe('mainnet');
		expect(c.entry.trigger).toBe('new_launch');
		expect(c.sizing.amount_sol).toBe(STRATEGY_CONFIG_DEFAULTS.sizing.amount_sol);
		expect(c.exits.stop_loss_pct).toBe(STRATEGY_CONFIG_DEFAULTS.exits.stop_loss_pct);
		expect(c.risk.max_concurrent_positions).toBe(STRATEGY_CONFIG_DEFAULTS.risk.max_concurrent_positions);
	});

	it('clamps per-trade size to the hard ceiling (never a runaway number)', () => {
		expect(normalizeStrategyConfig({ sizing: { amount_sol: 9_999 } }).sizing.amount_sol).toBe(100);
		expect(normalizeStrategyConfig({ sizing: { amount_sol: -5 } }).sizing.amount_sol).toBe(0.0001);
	});

	it('clamps slippage into [0, 10000] bps and rounds it', () => {
		expect(normalizeStrategyConfig({ sizing: { max_slippage_bps: 50_000 } }).sizing.max_slippage_bps).toBe(10_000);
		expect(normalizeStrategyConfig({ sizing: { max_slippage_bps: 123.7 } }).sizing.max_slippage_bps).toBe(124);
	});

	it('clamps stop-loss into [1, 99] and applies the default when invalid', () => {
		expect(normalizeStrategyConfig({ exits: { stop_loss_pct: 250 } }).exits.stop_loss_pct).toBe(99);
		expect(normalizeStrategyConfig({ exits: { stop_loss_pct: 'nonsense' } }).exits.stop_loss_pct).toBe(STRATEGY_CONFIG_DEFAULTS.exits.stop_loss_pct);
	});

	it('coerces empty-string optional fields to null, keeps real numbers', () => {
		const c = normalizeStrategyConfig({ entry: { min_liquidity_sol: '', max_market_cap_usd: '50000' } });
		expect(c.entry.min_liquidity_sol).toBeNull();
		expect(c.entry.max_market_cap_usd).toBe(50_000);
	});

	it('rejects an unknown network / trigger and falls back to defaults', () => {
		const c = normalizeStrategyConfig({ network: 'testnet', entry: { trigger: 'rug_pull' } });
		expect(c.network).toBe('mainnet');
		expect(c.entry.trigger).toBe('new_launch');
	});

	it('clamps max_concurrent_positions to >= 1 (never zero — a 0 would never trade)', () => {
		expect(normalizeStrategyConfig({ risk: { max_concurrent_positions: 0 } }).risk.max_concurrent_positions).toBe(1);
		expect(normalizeStrategyConfig({ risk: { max_concurrent_positions: 999 } }).risk.max_concurrent_positions).toBe(50);
	});
});

describe('validateStrategyConfig', () => {
	const good = {
		sizing: { amount_sol: 0.2 },
		exits: { take_profit_pct: 100, stop_loss_pct: 40 },
	};

	it('accepts a sane config and returns the normalized form', () => {
		const { valid, errors, config } = validateStrategyConfig(good);
		expect(valid).toBe(true);
		expect(errors).toHaveLength(0);
		expect(config.exits.stop_loss_pct).toBe(40);
	});

	it('requires at least one upside exit (TP, trailing, or max-hold)', () => {
		const { valid, errors } = validateStrategyConfig({
			sizing: { amount_sol: 0.1 },
			exits: { take_profit_pct: null, trailing_stop_pct: null, max_hold_minutes: null, stop_loss_pct: 40 },
		});
		expect(valid).toBe(false);
		expect(errors.some((e) => e.field === 'exits')).toBe(true);
	});

	it('accepts a trailing-stop-only upside (no fixed TP needed)', () => {
		const { valid } = validateStrategyConfig({
			sizing: { amount_sol: 0.1 },
			exits: { take_profit_pct: null, trailing_stop_pct: 25, stop_loss_pct: 40 },
		});
		expect(valid).toBe(true);
	});

	it('flags an inverted market-cap band', () => {
		const { valid, errors } = validateStrategyConfig({
			...good,
			entry: { min_market_cap_usd: 100_000, max_market_cap_usd: 10_000 },
		});
		expect(valid).toBe(false);
		expect(errors.some((e) => e.field === 'entry.max_market_cap_usd')).toBe(true);
	});

	it('always carries a stop-loss — the downside is never undefined', () => {
		const { config } = validateStrategyConfig({ sizing: { amount_sol: 0.1 }, exits: { take_profit_pct: 100 } });
		expect(config.exits.stop_loss_pct).toBeGreaterThan(0);
	});
});

describe('matchesEntry', () => {
	const cfg = normalizeStrategyConfig({
		entry: {
			max_age_minutes: 60,
			min_liquidity_sol: 5,
			min_market_cap_usd: 10_000,
			max_market_cap_usd: 500_000,
			require_socials: true,
			max_creator_launches: 3,
		},
	});
	const launch = (over = {}) => ({
		mint: 'THREEsynthetic1111111111111111111111111111',
		created_at: minsAgo(5),
		market_cap_usd: 50_000,
		liquidity_sol: 12,
		creator_launches: 1,
		twitter: 'x.com/agent',
		is_usdc_pair: false,
		...over,
	});

	it('passes a launch that clears every gate', () => {
		const r = matchesEntry(cfg, launch(), NOW);
		expect(r.pass).toBe(true);
	});

	it('rejects a launch older than the age window', () => {
		const r = matchesEntry(cfg, launch({ created_at: minsAgo(120) }), NOW);
		expect(r.pass).toBe(false);
		expect(r.reasons[0]).toMatch(/too_old/);
	});

	it('rejects below-min liquidity', () => {
		expect(matchesEntry(cfg, launch({ liquidity_sol: 1 }), NOW).pass).toBe(false);
	});

	it('rejects a market cap outside the band on both ends', () => {
		expect(matchesEntry(cfg, launch({ market_cap_usd: 1_000 }), NOW).pass).toBe(false);
		expect(matchesEntry(cfg, launch({ market_cap_usd: 9_000_000 }), NOW).pass).toBe(false);
	});

	it('rejects a serial deployer over the creator-launch cap', () => {
		expect(matchesEntry(cfg, launch({ creator_launches: 10 }), NOW).pass).toBe(false);
	});

	it('rejects when socials are required but absent', () => {
		expect(matchesEntry(cfg, launch({ twitter: null, telegram: null, website: null }), NOW).pass).toBe(false);
	});

	it('rejects a non-SOL-quoted pair when the strategy requires SOL', () => {
		const solOnly = normalizeStrategyConfig({ entry: { require_sol_quote: true } });
		expect(matchesEntry(solOnly, launch({ is_usdc_pair: true }), NOW).pass).toBe(false);
	});

	it('rejects a launch with no mint outright', () => {
		expect(matchesEntry(cfg, { mint: null }, NOW).pass).toBe(false);
	});

	it('treats clock-skewed (future) timestamps as fresh, not a hard reject', () => {
		const r = matchesEntry(cfg, launch({ created_at: NOW + 60_000 }), NOW);
		expect(r.pass).toBe(true);
	});
});

describe('shouldExit', () => {
	const cfg = normalizeStrategyConfig({
		exits: { take_profit_pct: 100, stop_loss_pct: 40, trailing_stop_pct: 25, max_hold_minutes: 120 },
	});
	const pos = (over = {}) => ({ entry_lamports: 1_000_000, peak_value_lamports: 1_000_000, opened_at: minsAgo(10), ...over });

	it('holds inside the band', () => {
		expect(shouldExit(cfg, pos(), 1_200_000, NOW).exit).toBe(false);
	});

	it('takes profit at the +TP threshold (2x)', () => {
		const r = shouldExit(cfg, pos(), 2_000_000, NOW);
		expect(r.exit).toBe(true);
		expect(r.reason).toBe('take_profit');
	});

	it('stops out at the -SL threshold', () => {
		const r = shouldExit(cfg, pos(), 600_000, NOW);
		expect(r.exit).toBe(true);
		expect(r.reason).toBe('stop_loss');
	});

	it('trails: exits when value drops the trail % from the peak (below the TP line)', () => {
		// peak +80% (under the +100% TP), now +30% → 27.8% off peak, past the 25% trail.
		const r = shouldExit(cfg, pos({ peak_value_lamports: 1_800_000 }), 1_300_000, NOW);
		expect(r.exit).toBe(true);
		expect(r.reason).toBe('trailing_stop');
	});

	it('times out past max-hold even when price-flat', () => {
		const r = shouldExit(cfg, pos({ opened_at: minsAgo(200) }), 1_000_000, NOW);
		expect(r.exit).toBe(true);
		expect(r.reason).toBe('timeout');
	});

	it('honest with no entry basis: only the time exit can fire', () => {
		const noBasis = pos({ entry_lamports: 0 });
		expect(shouldExit(cfg, noBasis, 5_000_000, NOW).exit).toBe(false);
		expect(shouldExit(cfg, { ...noBasis, opened_at: minsAgo(200) }, 5_000_000, NOW).reason).toBe('timeout');
	});

	it('take-profit takes precedence over stop-loss when both could be argued', () => {
		// A huge jump can only be TP; confirm TP fires (precedence ordering is TP→SL).
		expect(shouldExit(cfg, pos(), 10_000_000, NOW).reason).toBe('take_profit');
	});
});

describe('slugifyStrategy', () => {
	it('produces a url-safe slug', () => {
		expect(slugifyStrategy('Fresh-Launch Sniper!! 🚀')).toBe('fresh-launch-sniper');
	});
	it('falls back to "strategy" for empty / symbol-only names', () => {
		expect(slugifyStrategy('')).toBe('strategy');
		expect(slugifyStrategy('@@@')).toBe('strategy');
	});
	it('caps slug length so a very long name can never overflow', () => {
		expect(slugifyStrategy('a'.repeat(200)).length).toBeLessThanOrEqual(48);
	});
});

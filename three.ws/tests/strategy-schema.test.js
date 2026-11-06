/**
 * Strategy Object schema — pure logic tests.
 * Money-adjacent: the config is the leash on an autonomous trader, so every bound,
 * validation rule, entry gate, and exit trigger is pinned. A malformed rule set must
 * never persist, and an entry/exit verdict must be deterministic and explainable.
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeStrategyConfig, validateStrategyConfig, matchesEntry, shouldExit,
	slugifyStrategy, STRATEGY_CONFIG_DEFAULTS,
} from '../api/_lib/strategy-schema.js';

describe('normalizeStrategyConfig', () => {
	it('fills a complete, bounded config from empty input', () => {
		const c = normalizeStrategyConfig({});
		expect(c.network).toBe('mainnet');
		expect(c.entry.trigger).toBe('new_launch');
		expect(c.entry.max_age_minutes).toBe(STRATEGY_CONFIG_DEFAULTS.entry.max_age_minutes);
		expect(c.sizing.amount_sol).toBe(STRATEGY_CONFIG_DEFAULTS.sizing.amount_sol);
		// stop-loss is mandatory → always defaulted; upside exits are optional → null
		// unless explicitly set (validation then requires at least one of them).
		expect(c.exits.stop_loss_pct).toBe(40);
		expect(c.exits.take_profit_pct).toBeNull();
		expect(c.risk.max_concurrent_positions).toBe(STRATEGY_CONFIG_DEFAULTS.risk.max_concurrent_positions);
	});

	it('clamps per-trade size to the hard ceiling and floor', () => {
		expect(normalizeStrategyConfig({ sizing: { amount_sol: 999 } }).sizing.amount_sol).toBe(100);
		expect(normalizeStrategyConfig({ sizing: { amount_sol: 0 } }).sizing.amount_sol).toBe(0.0001);
		expect(normalizeStrategyConfig({ sizing: { amount_sol: -5 } }).sizing.amount_sol).toBe(0.0001);
	});

	it('clamps stop-loss into (0,99] and keeps it mandatory', () => {
		expect(normalizeStrategyConfig({ exits: { stop_loss_pct: 500 } }).exits.stop_loss_pct).toBe(99);
		// invalid → default, never absent
		expect(normalizeStrategyConfig({ exits: { stop_loss_pct: 'nope' } }).exits.stop_loss_pct).toBe(40);
	});

	it('coerces blank optional numbers to null, not 0', () => {
		const e = normalizeStrategyConfig({ entry: { min_liquidity_sol: '', max_creator_launches: null } }).entry;
		expect(e.min_liquidity_sol).toBeNull();
		expect(e.max_creator_launches).toBeNull();
	});

	it('rounds integer fields', () => {
		expect(normalizeStrategyConfig({ entry: { max_age_minutes: 12.7 } }).entry.max_age_minutes).toBe(13);
		expect(normalizeStrategyConfig({ risk: { max_concurrent_positions: 3.9 } }).risk.max_concurrent_positions).toBe(4);
	});

	it('only accepts known triggers and networks', () => {
		expect(normalizeStrategyConfig({ entry: { trigger: 'evil' } }).entry.trigger).toBe('new_launch');
		expect(normalizeStrategyConfig({ network: 'fakenet' }).network).toBe('mainnet');
		expect(normalizeStrategyConfig({ network: 'devnet' }).network).toBe('devnet');
	});
});

describe('validateStrategyConfig', () => {
	it('accepts a config with a take-profit and stop-loss', () => {
		const { valid, errors } = validateStrategyConfig({ exits: { take_profit_pct: 100, stop_loss_pct: 40 } });
		expect(valid).toBe(true);
		expect(errors).toEqual([]);
	});

	it('rejects an empty config — every strategy must define an upside exit', () => {
		const { valid, errors } = validateStrategyConfig({});
		expect(valid).toBe(false);
		expect(errors.some((e) => e.field === 'exits')).toBe(true);
	});

	it('requires at least one upside exit', () => {
		const { valid, errors } = validateStrategyConfig({ exits: { take_profit_pct: null, trailing_stop_pct: null, max_hold_minutes: null, stop_loss_pct: 40 } });
		expect(valid).toBe(false);
		expect(errors.some((e) => e.field === 'exits')).toBe(true);
	});

	it('rejects min market cap above max', () => {
		const { valid, errors } = validateStrategyConfig({ entry: { min_market_cap_usd: 1000, max_market_cap_usd: 100 } });
		expect(valid).toBe(false);
		expect(errors.some((e) => e.field === 'entry.max_market_cap_usd')).toBe(true);
	});

	it('always returns a persist-safe normalized config even when invalid', () => {
		const { config } = validateStrategyConfig({ sizing: { amount_sol: 'xx' } });
		expect(config.sizing.amount_sol).toBe(STRATEGY_CONFIG_DEFAULTS.sizing.amount_sol);
	});
});

describe('matchesEntry', () => {
	const now = 1_000_000_000_000;
	const base = {
		mint: 'THREEsynthetic1111111111111111111111111111',
		created_at: now - 5 * 60_000, // 5 minutes old
		market_cap_usd: 50_000,
		liquidity_sol: 12,
		creator_launches: 1,
		creator_graduated: 1,
		twitter: 'x', telegram: null, website: null,
		is_usdc_pair: false,
	};

	it('passes a fresh launch that clears every gate', () => {
		const c = normalizeStrategyConfig({ entry: { max_age_minutes: 60, min_liquidity_sol: 5, require_socials: true } });
		const r = matchesEntry(c, base, now);
		expect(r.pass).toBe(true);
		expect(r.reasons).toContain('has_socials');
	});

	it('rejects a launch older than the age gate', () => {
		const c = normalizeStrategyConfig({ entry: { max_age_minutes: 1 } });
		const r = matchesEntry(c, base, now);
		expect(r.pass).toBe(false);
		expect(r.reasons[0]).toMatch(/too_old/);
	});

	it('rejects a USDC-quoted pair when SOL quote is required', () => {
		const c = normalizeStrategyConfig({ entry: { require_sol_quote: true } });
		const r = matchesEntry(c, { ...base, is_usdc_pair: true }, now);
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('quote_not_sol');
	});

	it('rejects below-min liquidity and above-max market cap', () => {
		expect(matchesEntry(normalizeStrategyConfig({ entry: { min_liquidity_sol: 100 } }), base, now).pass).toBe(false);
		expect(matchesEntry(normalizeStrategyConfig({ entry: { max_market_cap_usd: 1000 } }), base, now).pass).toBe(false);
	});

	it('rejects serial creators and missing socials', () => {
		expect(matchesEntry(normalizeStrategyConfig({ entry: { max_creator_launches: 0 } }), { ...base, creator_launches: 9 }, now).pass).toBe(false);
		expect(matchesEntry(normalizeStrategyConfig({ entry: { require_socials: true } }), { ...base, twitter: null, telegram: null, website: null }, now).pass).toBe(false);
	});

	it('never passes a launch with no mint', () => {
		expect(matchesEntry(normalizeStrategyConfig({}), { mint: null }, now).pass).toBe(false);
	});

	it('treats a future/bad timestamp as fresh (no negative-age reject)', () => {
		const r = matchesEntry(normalizeStrategyConfig({ entry: { max_age_minutes: 10 } }), { ...base, created_at: now + 60_000 }, now);
		expect(r.pass).toBe(true);
	});
});

describe('shouldExit', () => {
	const now = 2_000_000_000_000;
	const cfg = (over) => normalizeStrategyConfig({ exits: { take_profit_pct: 100, stop_loss_pct: 40, ...over } });
	const pos = { entry_lamports: 1_000_000_000, peak_value_lamports: 1_000_000_000, opened_at: now - 60_000 };

	it('exits on take-profit at +100% (2x)', () => {
		const r = shouldExit(cfg(), pos, 2_000_000_000, now);
		expect(r).toEqual({ exit: true, reason: 'take_profit' });
	});

	it('exits on stop-loss at -40%', () => {
		const r = shouldExit(cfg(), pos, 600_000_000, now);
		expect(r).toEqual({ exit: true, reason: 'stop_loss' });
	});

	it('exits on a trailing stop from the peak (no take-profit set)', () => {
		const p = { ...pos, peak_value_lamports: 3_000_000_000 };
		// take_profit null so the +100% move doesn't pre-empt the trailing check
		const r = shouldExit(cfg({ take_profit_pct: null, trailing_stop_pct: 20 }), p, 2_000_000_000, now); // 33% off peak
		expect(r).toEqual({ exit: true, reason: 'trailing_stop' });
	});

	it('exits on max-hold timeout even with no entry basis', () => {
		const p = { entry_lamports: null, peak_value_lamports: null, opened_at: now - 120 * 60_000 };
		const r = shouldExit(cfg({ max_hold_minutes: 60 }), p, 0, now);
		expect(r).toEqual({ exit: true, reason: 'timeout' });
	});

	it('holds inside the band', () => {
		expect(shouldExit(cfg(), pos, 1_200_000_000, now).exit).toBe(false);
	});

	it('does not act on price with no real entry basis', () => {
		const p = { entry_lamports: 0, peak_value_lamports: 0, opened_at: now };
		expect(shouldExit(cfg(), p, 5_000_000_000, now).exit).toBe(false);
	});
});

describe('slugifyStrategy', () => {
	it('produces url-safe stable slugs', () => {
		expect(slugifyStrategy('Fresh-Launch Sniper!!')).toBe('fresh-launch-sniper');
		expect(slugifyStrategy('   ')).toBe('strategy');
		expect(slugifyStrategy('a'.repeat(80)).length).toBeLessThanOrEqual(48);
	});
});

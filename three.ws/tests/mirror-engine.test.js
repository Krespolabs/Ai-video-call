/**
 * Custodial mirror-trade decision engine — pure logic tests.
 * Money-adjacent: every sizing path, leash, list, and skip reason is pinned so a
 * runaway leader can never drain a follower past the first clamp.
 */

import { describe, it, expect } from 'vitest';
import {
	planMirror, normalizeFollowInput, rawMirrorSol, MIN_MIRROR_BUY_SOL,
} from '../api/_lib/mirror-engine.js';

const base = {
	enabled: true,
	sizing_mode: 'proportional',
	fixed_sol: 0.2,
	proportion_pct: 100,
	pct_balance: 10,
	max_per_trade_sol: null,
	daily_budget_sol: null,
	min_leader_sol: 0,
	copy_sells: true,
	mint_allowlist: [],
	mint_denylist: [],
};
const follow = (over = {}) => ({ ...base, ...over });
const buy = (leaderSol = 1, mint = 'MintAAA') => ({ side: 'buy', mint, leaderSol });
const sell = (mint = 'MintAAA') => ({ side: 'sell', mint });

describe('rawMirrorSol', () => {
	it('fixed → the fixed amount regardless of leader size', () => {
		expect(rawMirrorSol(follow({ sizing_mode: 'fixed' }), { leaderSol: 5 })).toBe(0.2);
	});
	it('proportional → leader size × proportion', () => {
		expect(rawMirrorSol(follow({ proportion_pct: 50 }), { leaderSol: 2 })).toBe(1);
		expect(rawMirrorSol(follow({ proportion_pct: 100 }), { leaderSol: 0.5 })).toBe(0.5);
	});
	it('pct_balance → percent of the follower balance, NaN without a balance', () => {
		expect(rawMirrorSol(follow({ sizing_mode: 'pct_balance', pct_balance: 10 }), { followerBalanceSol: 4 })).toBe(0.4);
		expect(Number.isNaN(rawMirrorSol(follow({ sizing_mode: 'pct_balance' }), {}))).toBe(true);
	});
});

describe('planMirror — gates', () => {
	it('kill switch blocks everything', () => {
		expect(planMirror({ follow: follow(), leaderTrade: buy(), killed: true }).reason).toBe('mirror_killed');
	});
	it('disabled follow is skipped', () => {
		expect(planMirror({ follow: follow({ enabled: false }), leaderTrade: buy() }).reason).toBe('follow_disabled');
	});
	it('denylisted mint is skipped (both directions)', () => {
		const f = follow({ mint_denylist: ['MintAAA'] });
		expect(planMirror({ follow: f, leaderTrade: buy(1, 'MintAAA') }).reason).toBe('mint_denylisted');
		expect(planMirror({ follow: f, leaderTrade: sell('MintAAA') }).reason).toBe('mint_denylisted');
	});
	it('allowlist excludes everything not on it', () => {
		const f = follow({ mint_allowlist: ['Other'] });
		expect(planMirror({ follow: f, leaderTrade: buy(1, 'MintAAA') }).reason).toBe('mint_not_allowlisted');
		expect(planMirror({ follow: f, leaderTrade: buy(1, 'Other'), followerBalanceSol: 10 }).action).toBe('mirror');
	});
});

describe('planMirror — sells', () => {
	it('mirrors an exit when copy_sells is on', () => {
		const d = planMirror({ follow: follow(), leaderTrade: sell() });
		expect(d).toMatchObject({ action: 'mirror', side: 'sell', reason: 'mirror_exit' });
	});
	it('skips an exit when copy_sells is off', () => {
		expect(planMirror({ follow: follow({ copy_sells: false }), leaderTrade: sell() }).reason).toBe('sells_disabled');
	});
});

describe('planMirror — buy sizing + leashes', () => {
	it('proportional sizing, fully funded → mirror at the sized amount', () => {
		const d = planMirror({ follow: follow({ proportion_pct: 50 }), leaderTrade: buy(2), followerBalanceSol: 10 });
		expect(d).toMatchObject({ action: 'mirror', side: 'buy', order_sol: 1 });
	});
	it('per-trade cap clamps the order down', () => {
		const d = planMirror({ follow: follow({ max_per_trade_sol: 0.3 }), leaderTrade: buy(2), followerBalanceSol: 10 });
		expect(d.order_sol).toBe(0.3);
	});
	it('leader buy below the floor is skipped', () => {
		const d = planMirror({ follow: follow({ min_leader_sol: 1 }), leaderTrade: buy(0.5), followerBalanceSol: 10 });
		expect(d.reason).toBe('below_min_leader');
	});
	it('daily budget remaining clamps and can exhaust', () => {
		const f = follow({ sizing_mode: 'fixed', fixed_sol: 1, daily_budget_sol: 1.2 });
		expect(planMirror({ follow: f, leaderTrade: buy(), followerBalanceSol: 10, spentTodaySol: 0.5 }).order_sol).toBeCloseTo(0.7, 6);
		expect(planMirror({ follow: f, leaderTrade: buy(), followerBalanceSol: 10, spentTodaySol: 1.2 }).reason).toBe('follow_daily_spent');
	});
	it('wallet balance clamps the order (keeps fee headroom)', () => {
		const d = planMirror({ follow: follow({ sizing_mode: 'fixed', fixed_sol: 5 }), leaderTrade: buy(), followerBalanceSol: 1 });
		expect(d.order_sol).toBeCloseTo(0.996, 3);
	});
	it('dust order is skipped', () => {
		const d = planMirror({ follow: follow({ sizing_mode: 'fixed', fixed_sol: 0.0001 }), leaderTrade: buy(), followerBalanceSol: 10 });
		expect(d.reason).toBe('below_dust');
		expect(0.0001).toBeLessThan(MIN_MIRROR_BUY_SOL);
	});
	it('pct_balance without a balance cannot be sized', () => {
		const d = planMirror({ follow: follow({ sizing_mode: 'pct_balance', pct_balance: 10 }), leaderTrade: buy(), followerBalanceSol: null });
		expect(d.reason).toBe('sizing_unavailable');
	});
});

describe('normalizeFollowInput', () => {
	it('defaults to proportional 100%', () => {
		const r = normalizeFollowInput({});
		expect(r.ok).toBe(true);
		expect(r.value).toMatchObject({ sizing_mode: 'proportional', proportion_pct: 100, copy_sells: true });
	});
	it('rejects a non-positive fixed size', () => {
		expect(normalizeFollowInput({ sizing_mode: 'fixed', fixed_sol: 0 }).ok).toBe(false);
	});
	it('rejects pct_balance outside (0,100]', () => {
		expect(normalizeFollowInput({ sizing_mode: 'pct_balance', pct_balance: 0 }).ok).toBe(false);
		expect(normalizeFollowInput({ sizing_mode: 'pct_balance', pct_balance: 150 }).ok).toBe(false);
		expect(normalizeFollowInput({ sizing_mode: 'pct_balance', pct_balance: 25 }).ok).toBe(true);
	});
	it('filters mint lists to valid base58 and caps length', () => {
		const r = normalizeFollowInput({ mint_denylist: ['bad!', 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', 123] });
		expect(r.value.mint_denylist).toEqual(['FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump']);
	});
});

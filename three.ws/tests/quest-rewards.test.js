/**
 * The $THREE daily-clear reward (api/_lib/quest-rewards.js) ships DISARMED.
 *
 * Paying it spends $THREE from a platform wallet, which is an owner-gated action.
 * These tests pin the gate: with the switch off (the default, and every
 * half-configured state) a claim returns before it reads a row, writes a row,
 * or calls the transfer. With it armed, the payout path is idempotent, bounded
 * by a daily budget, and records failures so a retry is possible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/db.js', () => ({ sql: vi.fn(() => { throw new Error('the default db must never be touched in these tests'); }) }));

const R = await import('../api/_lib/quest-rewards.js');

const USER = 'user-1';
const NOW = Date.UTC(2026, 8, 29, 15);
const TODAY = '2026-09-29';
const ARMED = {
	TRADING_QUEST_THREE_REWARDS: 'on',
	TRADING_QUEST_THREE_REWARD_AMOUNT: '250',
	TRADING_QUEST_THREE_REWARD_SECRET_KEY_B64: Buffer.alloc(64, 7).toString('base64'),
};

function fakeSql(state) {
	const calls = [];
	const sql = (strings, ...values) => {
		const text = strings.join('?');
		calls.push({ text, values });
		if (text.includes('from trading_quest_completions')) return Promise.resolve(state.cleared ? [{ ok: 1 }] : []);
		if (text.includes('from user_wallets')) return Promise.resolve(state.wallet ? [{ address: state.wallet }] : []);
		if (text.includes('select status, tx_signature from trading_quest_three_rewards')) return Promise.resolve(state.existing ? [state.existing] : []);
		if (text.includes('coalesce(sum(amount_atomic)')) return Promise.resolve([{ spent: state.spent || '0' }]);
		if (text.includes('insert into trading_quest_three_rewards')) return Promise.resolve(state.insertLoses ? [] : [{ user_id: USER }]);
		if (text.includes("set status = 'pending'")) return Promise.resolve([{ user_id: USER }]);
		if (text.includes("set status = 'sent'")) { state.sent = values[0]; return Promise.resolve([]); }
		if (text.includes("set status = 'failed'")) { state.failed = values[0]; return Promise.resolve([]); }
		return Promise.resolve([]);
	};
	return { sql, calls };
}

let state;
beforeEach(() => {
	state = { cleared: true, wallet: 'THREEsyntheticWa11et111111111111111111111' };
});

describe('questRewardConfig', () => {
	it('is disarmed by default', () => {
		const cfg = R.questRewardConfig({});
		expect(cfg.armed).toBe(false);
		expect(cfg.reason).toMatch(/TRADING_QUEST_THREE_REWARDS is off/);
	});

	it('stays disarmed when half configured', () => {
		expect(R.questRewardConfig({ TRADING_QUEST_THREE_REWARDS: 'on' }).armed).toBe(false);
		expect(R.questRewardConfig({ TRADING_QUEST_THREE_REWARDS: 'on', TRADING_QUEST_THREE_REWARD_AMOUNT: '10' }).armed).toBe(false);
		expect(R.questRewardConfig({ ...ARMED, TRADING_QUEST_THREE_REWARDS: 'off' }).armed).toBe(false);
	});

	it('arms only with the switch, an amount and a signer, and budgets 20x by default', () => {
		const cfg = R.questRewardConfig(ARMED);
		expect(cfg.armed).toBe(true);
		expect(cfg.amount_atomic).toBe(250_000_000n);
		expect(cfg.daily_budget_whole).toBe(5000);
		expect(cfg.mint).toBe(R.THREE_MINT_DEFAULT);
	});

	it('never exposes the key or the reason publicly', () => {
		expect(R.publicRewardInfo(R.questRewardConfig({}))).toEqual({ armed: false });
		expect(R.publicRewardInfo(R.questRewardConfig(ARMED))).toEqual({ armed: true, amount_three: 250 });
	});

	it('converts whole $THREE to 6-decimal atomic units exactly', () => {
		expect(R.toAtomic(1)).toBe(1_000_000n);
		expect(R.toAtomic(0.000001)).toBe(1n);
		expect(R.toAtomic(12.5)).toBe(12_500_000n);
	});
});

describe('claimDailyClearReward while disarmed', () => {
	it('touches neither the database nor the chain', async () => {
		const { sql, calls } = fakeSql(state);
		const sendThree = vi.fn();
		const r = await R.claimDailyClearReward({ userId: USER, day: TODAY, now: NOW, env: {}, deps: { sql, sendThree } });
		expect(r).toMatchObject({ ok: false, status: 409, code: 'rewards_disarmed' });
		expect(calls).toHaveLength(0);
		expect(sendThree).not.toHaveBeenCalled();
	});

	it('falls back to the real env and still refuses, without a db call', async () => {
		const prev = process.env.TRADING_QUEST_THREE_REWARDS;
		delete process.env.TRADING_QUEST_THREE_REWARDS;
		try {
			const r = await R.claimDailyClearReward({ userId: USER, day: TODAY, now: NOW });
			expect(r.code).toBe('rewards_disarmed');
		} finally {
			if (prev !== undefined) process.env.TRADING_QUEST_THREE_REWARDS = prev;
		}
	});
});

describe('claimDailyClearReward when armed', () => {
	it('pays the configured amount once to the linked wallet and records the signature', async () => {
		const { sql } = fakeSql(state);
		const sendThree = vi.fn(async () => 'sig-123');
		const r = await R.claimDailyClearReward({ userId: USER, day: TODAY, now: NOW, env: ARMED, deps: { sql, sendThree } });
		expect(r).toEqual({ ok: true, status: 'sent', tx_signature: 'sig-123', amount_three: 250 });
		expect(sendThree).toHaveBeenCalledTimes(1);
		expect(sendThree.mock.calls[0][0]).toMatchObject({ wallet: state.wallet, amountAtomic: 250_000_000n });
		expect(state.sent).toBe('sig-123');
	});

	it('returns the earlier payout instead of paying twice', async () => {
		state.existing = { status: 'sent', tx_signature: 'sig-old' };
		const { sql } = fakeSql(state);
		const sendThree = vi.fn();
		const r = await R.claimDailyClearReward({ userId: USER, day: TODAY, now: NOW, env: ARMED, deps: { sql, sendThree } });
		expect(r).toMatchObject({ ok: true, tx_signature: 'sig-old' });
		expect(sendThree).not.toHaveBeenCalled();
	});

	it('refuses a concurrent claim that lost the ledger race', async () => {
		state.insertLoses = true;
		const { sql } = fakeSql(state);
		const sendThree = vi.fn();
		const r = await R.claimDailyClearReward({ userId: USER, day: TODAY, now: NOW, env: ARMED, deps: { sql, sendThree } });
		expect(r.code).toBe('in_flight');
		expect(sendThree).not.toHaveBeenCalled();
	});

	it('requires the day to be cleared, a linked wallet, and today or yesterday', async () => {
		const sendThree = vi.fn();
		expect((await R.claimDailyClearReward({ userId: USER, day: TODAY, now: NOW, env: ARMED, deps: { sql: fakeSql({ ...state, cleared: false }).sql, sendThree } })).code).toBe('not_cleared');
		expect((await R.claimDailyClearReward({ userId: USER, day: TODAY, now: NOW, env: ARMED, deps: { sql: fakeSql({ ...state, wallet: null }).sql, sendThree } })).code).toBe('no_wallet');
		expect((await R.claimDailyClearReward({ userId: USER, day: '2026-09-20', now: NOW, env: ARMED, deps: { sql: fakeSql(state).sql, sendThree } })).code).toBe('invalid_day');
		expect((await R.claimDailyClearReward({ userId: USER, day: '2026-09-28', now: NOW, env: ARMED, deps: { sql: fakeSql(state).sql, sendThree: async () => 'sig-y' } })).ok).toBe(true);
		expect(sendThree).not.toHaveBeenCalled();
	});

	it('stops at the daily budget', async () => {
		state.spent = String(5000n * 1_000_000n);
		const { sql } = fakeSql(state);
		const sendThree = vi.fn();
		const r = await R.claimDailyClearReward({ userId: USER, day: TODAY, now: NOW, env: ARMED, deps: { sql, sendThree } });
		expect(r.code).toBe('budget_exhausted');
		expect(sendThree).not.toHaveBeenCalled();
	});

	it('records a failed transfer so the claim can be retried', async () => {
		const { sql } = fakeSql(state);
		const r = await R.claimDailyClearReward({
			userId: USER, day: TODAY, now: NOW, env: ARMED,
			deps: { sql, sendThree: async () => { throw new Error('blockhash expired'); } },
		});
		expect(r).toMatchObject({ ok: false, status: 502, code: 'payout_failed' });
		expect(state.failed).toBe('blockhash expired');

		state.existing = { status: 'failed' };
		const retry = await R.claimDailyClearReward({ userId: USER, day: TODAY, now: NOW, env: ARMED, deps: { sql: fakeSql(state).sql, sendThree: async () => 'sig-retry' } });
		expect(retry).toMatchObject({ ok: true, tx_signature: 'sig-retry' });
	});
});

// Trading growth programs (docs/growth-programs.md): the big-win X lane, the
// first-rug softener, and the early-leader bonus. Every program ships disarmed,
// so the load-bearing tests here are the ones proving the side-effecting leg
// (a post to X, a $THREE transfer) never runs while its flag is unset, and that
// the caps hold when it is set.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// A recording stand-in for the Neon tagged template. Handlers match on the SQL
// text; anything unmatched resolves to no rows.
function fakeSql(handlers = []) {
	const calls = [];
	const fn = (strings, ...values) => {
		const text = strings.join('?').replace(/\s+/g, ' ').trim();
		calls.push({ text, values });
		for (const [re, result] of handlers) {
			if (re.test(text)) return Promise.resolve(typeof result === 'function' ? result(values, text) : result);
		}
		return Promise.resolve([]);
	};
	fn.calls = calls;
	fn.writes = () => calls.filter((c) => /^(insert|update|delete)\b/i.test(c.text));
	return fn;
}

const globalSql = fakeSql();
vi.mock('../api/_lib/db.js', () => ({ sql: (...a) => globalSql(...a) }));

const { programConfig, flagOn, boundedNumber, CEILINGS } = await import('../api/_lib/growth-programs/config.js');
const { evaluateRugClaim, computeSoftenerAmount } = await import('../api/_lib/growth-programs/rug-softener.js');
const { qualifiedAt, evaluateEarlyLeader, assignSlots } = await import('../api/_lib/growth-programs/early-leaders.js');
const { bigWinRejection, composeBigWinPost, bigWinContentProblems, safeAgentName, selectBigWin, accountPostsLast24h, runBigWinLane } =
	await import('../api/_lib/growth-programs/big-win-x.js');
const { takeWithinCap, rowBlockReason, usdToAtomics, runPayoutQueue } = await import('../api/_lib/growth-programs/payouts.js');
const { runPayoutPrograms } = await import('../api/_lib/growth-programs/index.js');
const { shapeTradeCard } = await import('../api/_lib/trade-card.js');
const { loadXFilter } = await import('../api/_lib/changelog-push.js');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const wallet = () => Keypair.generate().publicKey.toBase58();
const SOL = (x) => String(Math.round(x * 1e9));

// ── config ────────────────────────────────────────────────────────────────────

describe('config', () => {
	it('arms a flag only on exactly "1" or "true"', () => {
		for (const v of ['1', 'true', 'TRUE', ' true ']) expect(flagOn('F', { F: v })).toBe(true);
		for (const v of [undefined, '', '0', 'false', 'yes', 'on', 'armed', '2']) expect(flagOn('F', { F: v })).toBe(false);
	});

	it('ships every program disarmed', () => {
		const cfg = programConfig({});
		expect(cfg.bigWinX.enabled).toBe(false);
		expect(cfg.rugSoftener.enabled).toBe(false);
		expect(cfg.earlyLeader.enabled).toBe(false);
	});

	it('never lets env raise a cap past its code ceiling', () => {
		const cfg = programConfig({
			RUG_SOFTENER_DAILY_CAP_USD: '1000000',
			RUG_SOFTENER_MAX_PER_CLAIM_USD: '5000',
			RUG_SOFTENER_REIMBURSE_PCT: '100',
			EARLY_LEADER_WEEKLY_CAP_USD: '99999',
			EARLY_LEADER_BONUS_USD: '9999',
			EARLY_LEADER_SLOTS: '100000',
			BIG_WIN_X_DAILY_CAP: '500',
			BIG_WIN_X_ACCOUNT_DAILY_CAP: '500',
		});
		expect(cfg.rugSoftener.dailyCapUsd).toBe(CEILINGS.rugSoftener.dailyCapUsd);
		expect(cfg.rugSoftener.maxPerClaimUsd).toBe(CEILINGS.rugSoftener.maxPerClaimUsd);
		expect(cfg.rugSoftener.reimbursePct).toBe(CEILINGS.rugSoftener.reimbursePct);
		expect(cfg.earlyLeader.weeklyCapUsd).toBe(CEILINGS.earlyLeader.weeklyCapUsd);
		expect(cfg.earlyLeader.bonusUsd).toBe(CEILINGS.earlyLeader.bonusUsd);
		expect(cfg.earlyLeader.slots).toBe(CEILINGS.earlyLeader.slots);
		expect(cfg.bigWinX.dailyCap).toBe(CEILINGS.bigWin.dailyCap);
		expect(cfg.bigWinX.accountDailyCap).toBe(CEILINGS.bigWin.accountDailyCap);
	});

	it('falls back to the default on garbage and clamps below the minimum', () => {
		expect(boundedNumber({ X: 'abc' }, 'X', { def: 5, min: 1, ceiling: 10 })).toBe(5);
		expect(boundedNumber({ X: '-3' }, 'X', { def: 5, min: 1, ceiling: 10 })).toBe(1);
		expect(boundedNumber({}, 'X', { def: 50, min: 1, ceiling: 10 })).toBe(10);
	});
});

// ── first-rug softener ───────────────────────────────────────────────────────

const rugCfg = programConfig({}).rugSoftener;

function rugEvidence(over = {}) {
	const posWallet = over.posWallet || wallet();
	return {
		user: { id: 'u1', created_at: new Date(NOW - 10 * DAY).toISOString(), is_admin: false, service_account: false },
		position: {
			id: 'p1',
			agent_id: 'a1',
			wallet: posWallet,
			mint: 'THREEsynthetic1111111111111111111111111111',
			status: 'closed',
			entry_quote_lamports: SOL(0.2),
			realized_pnl_lamports: SOL(-0.15),
			opened_at: new Date(NOW - 3 * DAY).toISOString(),
			closed_at: new Date(NOW - 2 * DAY).toISOString(),
		},
		solUsd: 120,
		earlierCopyAt: null,
		rug: { rugged: true, outcome: 'rugged', source: 'pump_coin_outcomes' },
		creator: wallet(),
		selfLaunched: false,
		userWallets: [posWallet],
		netSellerWallets: [],
		positionFunder: null,
		walletUsers: 1,
		existingClaim: false,
		...over,
	};
}

const unmetOf = (v) => v.unmet.map((u) => u.criterion);

describe('first-rug softener eligibility', () => {
	it('pays a first-timer whose first live trade hit a verified rug', () => {
		const v = evaluateRugClaim(rugEvidence(), rugCfg, NOW);
		expect(v.eligible).toBe(true);
		expect(v.unmet).toEqual([]);
		// 50% of 0.15 SOL at $120 = $9.00
		expect(v.amount.usd).toBe(9);
		expect(v.amount.capped).toBe(false);
	});

	it('refuses an account with no live trade', () => {
		const v = evaluateRugClaim(rugEvidence({ position: null }), rugCfg, NOW);
		expect(v.eligible).toBe(false);
		expect(unmetOf(v)).toEqual(['has_live_position']);
	});

	it('refuses a coin that went down but was not verified as a rug', () => {
		expect(unmetOf(evaluateRugClaim(rugEvidence({ rug: { rugged: false, outcome: 'flat' } }), rugCfg, NOW))).toContain('verified_rug');
		expect(unmetOf(evaluateRugClaim(rugEvidence({ rug: null }), rugCfg, NOW))).toContain('verified_rug');
	});

	it('refuses dust trades and gains', () => {
		const dust = rugEvidence();
		dust.position.entry_quote_lamports = SOL(0.001);
		dust.position.realized_pnl_lamports = SOL(-0.0009);
		expect(unmetOf(evaluateRugClaim(dust, rugCfg, NOW))).toEqual(expect.arrayContaining(['min_entry', 'realized_loss']));
		const win = rugEvidence();
		win.position.realized_pnl_lamports = SOL(0.05);
		expect(unmetOf(evaluateRugClaim(win, rugCfg, NOW))).toContain('realized_loss');
	});

	it('refuses the rugger: creator wallet, own launch, profitable insider wallet, or creator-funded wallet', () => {
		const creator = wallet();
		expect(unmetOf(evaluateRugClaim(rugEvidence({ creator, userWallets: [creator] }), rugCfg, NOW))).toContain('not_creator');
		expect(unmetOf(evaluateRugClaim(rugEvidence({ selfLaunched: true }), rugCfg, NOW))).toContain('not_creator');
		expect(unmetOf(evaluateRugClaim(rugEvidence({ netSellerWallets: [wallet()] }), rugCfg, NOW))).toContain('not_insider');
		expect(unmetOf(evaluateRugClaim(rugEvidence({ creator, positionFunder: creator }), rugCfg, NOW))).toContain('not_insider');
		expect(unmetOf(evaluateRugClaim(rugEvidence({ creator: null }), rugCfg, NOW))).toContain('creator_verified');
	});

	it('refuses sybil patterns: shared wallet, fresh account, platform account, repeat claim, earlier copy', () => {
		expect(unmetOf(evaluateRugClaim(rugEvidence({ walletUsers: 2 }), rugCfg, NOW))).toContain('wallet_unshared');
		const fresh = rugEvidence();
		fresh.user.created_at = new Date(NOW - 2 * HOUR).toISOString();
		expect(unmetOf(evaluateRugClaim(fresh, rugCfg, NOW))).toContain('account_age');
		const admin = rugEvidence();
		admin.user.is_admin = true;
		expect(unmetOf(evaluateRugClaim(admin, rugCfg, NOW))).toContain('not_platform_account');
		expect(unmetOf(evaluateRugClaim(rugEvidence({ existingClaim: true }), rugCfg, NOW))).toContain('not_claimed');
		expect(unmetOf(evaluateRugClaim(rugEvidence({ earlierCopyAt: '2026-09-01T00:00:00Z' }), rugCfg, NOW))).toContain('first_trade');
	});

	it('closes the claim window and needs the first trade closed', () => {
		const old = rugEvidence();
		old.position.closed_at = new Date(NOW - 40 * DAY).toISOString();
		expect(unmetOf(evaluateRugClaim(old, rugCfg, NOW))).toContain('claim_window');
		const open = rugEvidence();
		open.position.status = 'open';
		open.position.closed_at = null;
		expect(unmetOf(evaluateRugClaim(open, rugCfg, NOW))).toContain('first_position_closed');
	});

	it('caps the amount per claim and refuses to quote without a price', () => {
		const a = computeSoftenerAmount({ lossSol: 10, solUsd: 150, cfg: rugCfg });
		expect(a.usd).toBe(rugCfg.maxPerClaimUsd);
		expect(a.capped).toBe(true);
		expect(unmetOf(evaluateRugClaim(rugEvidence({ solUsd: null }), rugCfg, NOW))).toContain('price_available');
	});
});

// ── early leaders ─────────────────────────────────────────────────────────────

const leaderCfg = programConfig({}).earlyLeader;

function closes(count, { winEvery = 2, pnlWin = 0.05, pnlLoss = -0.01, entry = 0.1, spanDays = 40, start = NOW - 60 * DAY } = {}) {
	const rows = [];
	for (let i = 0; i < count; i++) {
		const win = i % winEvery !== winEvery - 1;
		rows.push({
			realized_pnl_lamports: SOL(win ? pnlWin : pnlLoss),
			entry_quote_lamports: SOL(entry),
			closed_at: new Date(start + (spanDays * DAY * i) / Math.max(1, count - 1)).toISOString(),
		});
	}
	return rows;
}

const goodAgent = { is_public: true, wallet: 'W', platform: false };

describe('early-leader program', () => {
	it('qualifies a profitable, long, followed record', () => {
		const rows = closes(40, { winEvery: 3 }); // 2 of every 3 win: ~67%
		const v = evaluateEarlyLeader({ rows, followers: { followers: 2, net_profit_sol: 0.4 }, agent: goodAgent }, leaderCfg);
		expect(v.unmet).toEqual([]);
		expect(v.eligible).toBe(true);
		expect(v.qualified_at).not.toBeNull();
	});

	it('needs followers who actually profit', () => {
		const rows = closes(40, { winEvery: 3 });
		expect(evaluateEarlyLeader({ rows, followers: { followers: 0, net_profit_sol: 0 }, agent: goodAgent }, leaderCfg).unmet.map((u) => u.criterion)).toContain('followers');
		expect(
			evaluateEarlyLeader({ rows, followers: { followers: 3, net_profit_sol: -0.2 }, agent: goodAgent }, leaderCfg).unmet.map((u) => u.criterion),
		).toContain('follower_outcome');
	});

	it('refuses a short, losing, private, or platform-owned record', () => {
		const short = evaluateEarlyLeader({ rows: closes(10, { spanDays: 5 }), followers: { followers: 1, net_profit_sol: 0 }, agent: goodAgent }, leaderCfg);
		expect(short.unmet.map((u) => u.criterion)).toEqual(expect.arrayContaining(['settled', 'span_days']));
		const losing = evaluateEarlyLeader({ rows: closes(40, { winEvery: 2, pnlWin: 0.01, pnlLoss: -0.05 }), followers: { followers: 1, net_profit_sol: 0 }, agent: goodAgent }, leaderCfg);
		expect(losing.unmet.map((u) => u.criterion)).toEqual(expect.arrayContaining(['win_rate', 'profitable']));
		const rows = closes(40, { winEvery: 3 });
		const f = { followers: 1, net_profit_sol: 0.1 };
		expect(evaluateEarlyLeader({ rows, followers: f, agent: { ...goodAgent, is_public: false } }, leaderCfg).unmet.map((u) => u.criterion)).toContain('public');
		expect(evaluateEarlyLeader({ rows, followers: f, agent: { ...goodAgent, platform: true } }, leaderCfg).unmet.map((u) => u.criterion)).toContain('not_platform');
		expect(evaluateEarlyLeader({ rows, followers: f, agent: { ...goodAgent, wallet: null } }, leaderCfg).unmet.map((u) => u.criterion)).toContain('wallet');
	});

	it('dates qualification to the first close that cleared every threshold', () => {
		const rows = closes(60, { winEvery: 3, spanDays: 59 });
		const at = qualifiedAt(rows, leaderCfg);
		const idx = rows.findIndex((r) => r.closed_at === at);
		// Needs 30 closes and 30 days of span; with one close a day, day 30 is the first.
		expect(idx).toBeGreaterThanOrEqual(leaderCfg.minSettled - 1);
		expect(qualifiedAt(rows.slice(0, idx), leaderCfg)).toBeNull();
	});

	it('fills slots first-come, one per owner, keeping slots already taken', () => {
		const s = (agent_id, user_id, qualified_at, eligible = true) => ({ agent_id, user_id, qualified_at, eligible });
		const standings = [
			s('a3', 'u3', '2026-09-03T00:00:00Z'),
			s('a1', 'u1', '2026-09-01T00:00:00Z'),
			s('a1b', 'u1', '2026-09-02T00:00:00Z'), // same owner as a1
			s('a4', 'u4', '2026-09-04T00:00:00Z'),
			s('a0', 'u0', '2026-08-01T00:00:00Z', false), // not eligible
			s('a9', 'u9', '2026-08-15T00:00:00Z'), // already has a slot
		];
		const { open_slots, winners } = assignSlots(standings, { takenAgentIds: new Set(['a9']), takenUserIds: new Set(['u9']), slots: 3 });
		expect(open_slots).toBe(2);
		expect(winners.map((w) => w.agent_id)).toEqual(['a1', 'a3']);
	});
});

// ── big-win X lane ───────────────────────────────────────────────────────────

const bigCfg = programConfig({}).bigWinX;
const filter = loadXFilter();

function winRow(over = {}) {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		agent_id: 'agent-1',
		user_id: 'user-1',
		network: 'mainnet',
		mint: 'THREEsynthetic1111111111111111111111111111',
		symbol: 'SYNTH',
		name: 'Synthetic',
		status: 'closed',
		exit_reason: 'take_profit',
		entry_quote_lamports: SOL(0.5),
		exit_quote_lamports: SOL(1.6),
		realized_pnl_lamports: SOL(1.1),
		realized_pnl_pct: 220,
		buy_sig: '5'.repeat(88),
		sell_sig: '4'.repeat(88),
		moonbag_base_amount: null,
		moonbag_last_value_lamports: null,
		opened_at: new Date(NOW - 2 * HOUR).toISOString(),
		closed_at: new Date(NOW - HOUR).toISOString(),
		agent_name: 'Crosshair',
		agent_image: null,
		is_public: true,
		...over,
	};
}

describe('big-win X lane', () => {
	it('accepts a live, sized win and rejects paper, small, and private ones', () => {
		expect(bigWinRejection(winRow(), bigCfg)).toBeNull();
		expect(bigWinRejection(winRow({ buy_sig: 'SIMULATED' }), bigCfg)).toBe('paper_or_unsigned');
		expect(bigWinRejection(winRow({ sell_sig: null }), bigCfg)).toBe('paper_or_unsigned');
		expect(bigWinRejection(winRow({ entry_quote_lamports: SOL(0.001), realized_pnl_lamports: SOL(0.002) }), bigCfg)).toMatch(/^below_min_entry/);
		expect(bigWinRejection(winRow({ realized_pnl_pct: 40 }), bigCfg)).toMatch(/^below_min_pct/);
		expect(bigWinRejection(winRow({ is_public: false }), bigCfg)).toBe('agent_private');
		expect(bigWinRejection(winRow(), bigCfg, { selfDealing: true })).toBe('self_dealing');
	});

	it('never names the traded coin, links the trade card, and passes the account filter', () => {
		const card = shapeTradeCard(winRow(), { origin: 'https://three.ws' });
		const text = composeBigWinPost(card);
		expect(text).toContain('https://three.ws/trade/11111111-1111-4111-8111-111111111111');
		expect(text).not.toMatch(/\$[A-Za-z]/);
		expect(text).not.toContain('SYNTH');
		expect(text).not.toContain('THREEsynthetic');
		expect(text).not.toMatch(/[\u2013\u2014]/);
		expect(bigWinContentProblems(text, filter)).toEqual([]);
	});

	it('refuses an agent name carrying a cashtag, handle, hashtag, or link', () => {
		for (const bad of ['Buy $SCAM', '@someone', '#pump', 'visit scam.io', 'x'.repeat(41), '']) expect(safeAgentName(bad)).toBeNull();
		expect(safeAgentName('Crosshair')).toBe('Crosshair');
	});

	it('respects the lane cap, the account-wide cap, and the per-agent cooldown', () => {
		const rows = [winRow()];
		const base = { rows, cfg: bigCfg, filter, selfDealByUser: new Map(), now: NOW };
		const ok = selectBigWin({ ...base, state: {}, budget: { lane: 0, total: 0 } });
		expect(ok.pick?.position_id).toBe(rows[0].id);
		expect(ok.blocked).toBeNull();
		expect(selectBigWin({ ...base, state: {}, budget: { lane: bigCfg.dailyCap, total: 0 } }).blocked).toMatch(/^daily_cap/);
		expect(selectBigWin({ ...base, state: {}, budget: { lane: 0, total: bigCfg.accountDailyCap } }).blocked).toMatch(/^account_daily_cap/);
		const cooled = selectBigWin({ ...base, state: { perAgent: { 'agent-1': NOW - HOUR } }, budget: { lane: 0, total: 0 } });
		expect(cooled.pick).toBeNull();
		const posted = selectBigWin({ ...base, state: { posted: [rows[0].id] }, budget: { lane: 0, total: 0 } });
		expect(posted.pick).toBeNull();
	});

	it('counts posts from every automated lane toward the account budget', () => {
		const b = accountPostsLast24h(
			{
				lane: { recent: [NOW - HOUR, NOW - 2 * DAY] },
				changelog: { recent: [NOW - HOUR, NOW - 3 * HOUR] },
				content: { published: [{ publishedAt: new Date(NOW - HOUR).toISOString() }, { publishedAt: new Date(NOW - 3 * DAY).toISOString() }] },
			},
			NOW,
		);
		expect(b).toEqual({ lane: 1, changelog: 2, content: 1, total: 4 });
	});

	it('never posts or writes state while BIG_WIN_X_ENABLED is unset, even with a qualifying win and credentials', async () => {
		const sql = fakeSql([[/from agent_sniper_positions p join agent_identities/i, [winRow({ closed_at: new Date(Date.now() - HOUR).toISOString() })]]]);
		const makePoster = vi.fn();
		const env = { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'a' };
		const out = await runBigWinLane({ cfg: programConfig({}).bigWinX, sql, env, makePoster });
		expect(out.executed).toBe(false);
		expect(out.would_post?.text).toContain('/trade/');
		expect(makePoster).not.toHaveBeenCalled();
		expect(sql.writes()).toEqual([]);
	});

	it('posts exactly one win and records it when armed', async () => {
		const sql = fakeSql([
			[/from agent_sniper_positions p join agent_identities/i, [winRow({ closed_at: new Date(Date.now() - HOUR).toISOString() })]],
			[/^insert into app_settings \(key, value\) values \(\?, jsonb_build_object/i, [{ key: 'big_win_x_lock' }]],
		]);
		const post = vi.fn(async () => '1900000000000000000');
		const makePoster = vi.fn(async () => post);
		const env = { BIG_WIN_X_ENABLED: '1', X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'a' };
		const out = await runBigWinLane({ cfg: programConfig(env).bigWinX, sql, env, makePoster });
		expect(out.executed).toBe(true);
		expect(post).toHaveBeenCalledTimes(1);
		const saved = sql.calls.find((c) => /^insert into app_settings \(key, value\) values \(\?, \?::jsonb\)/i.test(c.text) && c.values[0] === 'big_win_x');
		expect(JSON.parse(saved.values[1]).posted).toContain(winRow().id);
	});
});

// ── payout leg ────────────────────────────────────────────────────────────────

describe('capped payout leg', () => {
	it('takes queued payouts first-come while they fit the cap', () => {
		const items = [{ usd_value: 40 }, { usd_value: 40 }, { usd_value: 10 }];
		const { fits, deferred } = takeWithinCap(items, 90);
		expect(fits).toHaveLength(3);
		const tight = takeWithinCap(items, 60);
		expect(tight.fits).toHaveLength(1);
		expect(tight.deferred).toHaveLength(2); // the small one does not jump the queue
	});

	it('blocks invalid, platform, and zero payouts', () => {
		const w = wallet();
		expect(rowBlockReason({ recipient_wallet: 'nope', usd_value: 5 }, new Set())).toBe('invalid_wallet');
		expect(rowBlockReason({ recipient_wallet: w, usd_value: 5 }, new Set([w]))).toBe('platform_wallet');
		expect(rowBlockReason({ recipient_wallet: w, usd_value: 0 }, new Set())).toBe('zero_amount');
		expect(rowBlockReason({ recipient_wallet: w, usd_value: 5 }, new Set())).toBeNull();
	});

	it('converts USD to atomics at a live price', () => {
		expect(usdToAtomics(10, 0.002, 1_000_000n)).toBe(5_000_000_000n);
		expect(usdToAtomics(0, 1, 1_000_000n)).toBe(0n);
		expect(usdToAtomics(5, 0, 1_000_000n)).toBe(0n);
	});

	const queueRows = () => [
		{ id: 'r1', subject_key: 'position:p1', user_id: 'u1', recipient_wallet: wallet(), usd_value: 20, status: 'claimed' },
		{ id: 'r2', subject_key: 'position:p2', user_id: 'u2', recipient_wallet: wallet(), usd_value: 20, status: 'claimed' },
		{ id: 'r3', subject_key: 'position:p3', user_id: 'u3', recipient_wallet: wallet(), usd_value: 20, status: 'claimed' },
	];

	function payoutSql(rows, { spent = 0 } = {}) {
		return fakeSql([
			[/^select id, subject_key/i, rows],
			[/coalesce\(sum\(usd_value\), 0\)::float as usd/i, [{ usd: spent }]],
			[/^insert into app_settings/i, [{ key: 'lock' }]],
			[/^update growth_program_payouts set status = 'sending'/i, (values) => [{ id: values[values.length - 1] }]],
		]);
	}

	function deps() {
		return {
			payoutKey: () => bs58.encode(Keypair.generate().secretKey),
			price: vi.fn(async () => ({ priceUsd: 0.002, source: 'test' })),
			transfer: vi.fn(async () => 'sig' + Math.random().toString(36).slice(2)),
			mint: 'THREEsynthetic1111111111111111111111111111',
			decimals: 6,
			atomicsPerToken: 1_000_000n,
			platformWallets: [],
		};
	}

	it('pays only from the dedicated payout key, never the club treasury fallback', async () => {
		const { resolvePrizeKeyBase58 } = await import('../api/_lib/tournament-settlement.js');
		const saved = { p: process.env.THREE_PRIZE_PAYOUT_KEY, c: process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64 };
		try {
			delete process.env.THREE_PRIZE_PAYOUT_KEY;
			process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64 = Buffer.from(Keypair.generate().secretKey).toString('base64');
			expect(resolvePrizeKeyBase58()).not.toBeNull(); // the Arena prize rail keeps its fallback
			expect(resolvePrizeKeyBase58({ dedicatedOnly: true })).toBeNull();
			const dedicated = bs58.encode(Keypair.generate().secretKey);
			process.env.THREE_PRIZE_PAYOUT_KEY = dedicated;
			expect(resolvePrizeKeyBase58({ dedicatedOnly: true })).toBe(dedicated);
		} finally {
			if (saved.p === undefined) delete process.env.THREE_PRIZE_PAYOUT_KEY;
			else process.env.THREE_PRIZE_PAYOUT_KEY = saved.p;
			if (saved.c === undefined) delete process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64;
			else process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64 = saved.c;
		}
	});

	it('never transfers or writes while the program flag is unset', async () => {
		const sql = payoutSql(queueRows());
		const d = deps();
		const out = await runPayoutQueue({ program: 'rug_softener', enabled: false, flag: 'RUG_SOFTENER_ENABLED', capUsd: 100, periodHours: 24, deps: d, sql });
		expect(out.executed).toBe(false);
		expect(out.would_pay).toHaveLength(3);
		expect(d.transfer).not.toHaveBeenCalled();
		expect(d.price).not.toHaveBeenCalled();
		expect(sql.writes()).toEqual([]);
	});

	it('does not transfer when armed but the payout key is missing', async () => {
		const sql = payoutSql(queueRows());
		const d = { ...deps(), payoutKey: () => null };
		const out = await runPayoutQueue({ program: 'rug_softener', enabled: true, flag: 'RUG_SOFTENER_ENABLED', capUsd: 100, periodHours: 24, deps: d, sql });
		expect(out.executed).toBe(false);
		expect(out.reason).toMatch(/^payout_unconfigured/);
		expect(d.transfer).not.toHaveBeenCalled();
		expect(sql.writes()).toEqual([]);
	});

	it('pays within the period cap when armed, and stops at the cap', async () => {
		const sql = payoutSql(queueRows(), { spent: 55 });
		const d = deps();
		const out = await runPayoutQueue({ program: 'rug_softener', enabled: true, flag: 'RUG_SOFTENER_ENABLED', capUsd: 100, periodHours: 24, deps: d, sql });
		// $45 of headroom: two $20 payouts fit, the third waits for the window.
		expect(d.transfer).toHaveBeenCalledTimes(2);
		expect(out.results.filter((r) => r.status === 'sent')).toHaveLength(2);
		expect(out.deferred_by_cap).toHaveLength(1);
		const amounts = d.transfer.mock.calls.map(([arg]) => arg.amount);
		expect(amounts).toEqual([10_000_000_000n, 10_000_000_000n]); // $20 at $0.002 = 10,000 $THREE
	});

	it('pays nothing when the cap is already spent', async () => {
		const sql = payoutSql(queueRows(), { spent: 100 });
		const d = deps();
		await runPayoutQueue({ program: 'early_leader', enabled: true, flag: 'EARLY_LEADER_ENABLED', capUsd: 100, periodHours: 168, deps: d, sql });
		expect(d.transfer).not.toHaveBeenCalled();
	});

	it('the payout tick moves nothing and enrolls nobody with every flag unset', async () => {
		const leaderRows = closes(40, { winEvery: 3 }).map((r) => ({ ...r, agent_id: 'a1', user_id: 'u1', mint: 'm' }));
		const sql = fakeSql([
			[/from agent_sniper_positions p where p.network = 'mainnet' and p.status = 'closed'/i, leaderRows],
			[/from agent_identities a left join users u/i, [{ id: 'a1', user_id: 'u1', name: 'Leader', is_public: true, wallet: wallet(), is_admin: false, service_account: false }]],
			[/from copy_executions e/i, [{ leader_agent_id: 'a1', followers: 2, net_profit_sol: 0.3 }]],
			[/^select id, subject_key/i, queueRows()],
			[/coalesce\(sum\(usd_value\), 0\)::float as usd/i, [{ usd: 0 }]],
		]);
		const d = deps();
		const out = await runPayoutPrograms({ env: {}, sql, deps: d });
		expect(out.early_leader.would_enroll.map((w) => w.agent_id)).toEqual(['a1']);
		expect(out.early_leader.enrolled).toBe(0);
		expect(out.rug_softener.executed).toBe(false);
		expect(out.early_leader.executed).toBe(false);
		expect(d.transfer).not.toHaveBeenCalled();
		expect(sql.writes()).toEqual([]);
	});
});

beforeEach(() => {
	globalSql.calls.length = 0;
});

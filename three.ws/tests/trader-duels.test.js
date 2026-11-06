/**
 * Trader duels (api/_lib/trader-duels.js): the points-only skill-prediction game.
 *
 * Pins the pure rules (windows, phases, market generation, resolution with
 * ties, voids and idle traders, settlement, stake validation, badges, seasons)
 * and the database paths that enforce them: the abuse rules on a call, a
 * duel resolved from ledger positions through computeTraderMetrics, and a void
 * that refunds every stake.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let route = () => [];
const queries = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const q = Array.isArray(strings) ? strings.join('?') : String(strings);
		queries.push({ q, values });
		return Promise.resolve().then(() => route(q, values));
	},
	isDbUnavailableError: () => false,
}));

const unlocked = [];
vi.mock('../api/_lib/streaks.js', async (importOriginal) => {
	const real = await importOriginal();
	return {
		...real,
		unlockBadge: async (userId, code) => {
			unlocked.push({ userId, code });
			return true;
		},
		listBadges: async () => [],
	};
});

const D = await import('../api/_lib/trader-duels.js');
const { BADGES } = await import('../api/_lib/streaks.js');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const OWNER_A = '55555555-5555-4555-8555-555555555555';
const OWNER_B = '66666666-6666-4666-8666-666666666666';
const MARKET = '77777777-7777-4777-8777-777777777777';

beforeEach(() => {
	route = () => [];
	queries.length = 0;
	unlocked.length = 0;
});

describe('windows', () => {
	it('opens a day duel for the next UTC day', () => {
		const now = Date.parse('2026-09-30T15:20:00Z');
		const w = D.nextWindow('day', now);
		expect(new Date(w.start).toISOString()).toBe('2026-10-01T00:00:00.000Z');
		expect(new Date(w.end).toISOString()).toBe('2026-10-02T00:00:00.000Z');
		expect(D.windowOpensNow('day', w.start, now)).toBe(true);
	});

	it('runs a week duel Monday to Monday, always strictly in the future', () => {
		const wed = D.nextWindow('week', Date.parse('2026-09-30T12:00:00Z'));
		expect(new Date(wed.start).toISOString()).toBe('2026-10-05T00:00:00.000Z');
		expect(new Date(wed.end).toISOString()).toBe('2026-10-12T00:00:00.000Z');
		const mon = D.nextWindow('week', Date.parse('2026-10-05T00:00:01Z'));
		expect(new Date(mon.start).toISOString()).toBe('2026-10-12T00:00:00.000Z');
		const sun = D.nextWindow('week', Date.parse('2026-10-04T23:00:00Z'));
		expect(new Date(sun.start).toISOString()).toBe('2026-10-05T00:00:00.000Z');
	});

	it('only opens a week duel once the week is at most four days away', () => {
		const start = Date.parse('2026-10-05T00:00:00Z');
		expect(D.windowOpensNow('week', start, Date.parse('2026-09-30T12:00:00Z'))).toBe(false);
		expect(D.windowOpensNow('week', start, Date.parse('2026-10-01T00:05:00Z'))).toBe(true);
		expect(D.windowOpensNow('week', start, Date.parse('2026-10-05T00:00:00Z'))).toBe(false);
	});

	it('walks a duel through its phases', () => {
		const m = { status: 'open', window_start: '2026-10-01T00:00:00Z', window_end: '2026-10-02T00:00:00Z' };
		expect(D.duelPhase(m, Date.parse('2026-09-30T23:59:59Z'))).toBe('open');
		expect(D.duelPhase(m, Date.parse('2026-10-01T00:00:00Z'))).toBe('live');
		expect(D.duelPhase(m, Date.parse('2026-10-02T00:00:00Z'))).toBe('resolving');
		expect(D.duelPhase({ ...m, status: 'resolved' })).toBe('resolved');
		expect(D.duelPhase({ ...m, status: 'void' })).toBe('void');
		expect(D.resolvesAt(m)).toBe('2026-10-02T00:15:00.000Z');
	});
});

describe('planDuels (market generation)', () => {
	const riv = (leader, chaser, kind = 'chase') => ({
		kind,
		window: '30d',
		headline: `${leader} vs ${chaser}`,
		leader: { agent_id: leader, name: `T-${leader.slice(0, 1)}`, rank: 1, score: 70, closed: 12, win_rate: 0.6, realized_pnl_sol: 1.2 },
		chaser: { agent_id: chaser, name: `T-${chaser.slice(0, 1)}`, rank: 2, score: 60, closed: 9, win_rate: 0.5, realized_pnl_sol: 0.4 },
	});

	it('pairs each rivalry leader against the trader directly below', () => {
		const plan = D.planDuels([riv(A, B), riv(B, C)]);
		expect(plan).toHaveLength(2);
		expect(plan[0].a.agent_id).toBe(A);
		expect(plan[0].b.agent_id).toBe(B);
		expect(plan[0].context.headline).toBe(`${A} vs ${B}`);
		expect(plan[0].context.a.rank).toBe(1);
	});

	it('skips an unavailable trader, a repeated pair in either order, and a self pair', () => {
		const plan = D.planDuels([riv(A, B), riv(B, A), riv(A, A), riv(B, C)], { excluded: new Set([C]) });
		expect(plan.map((p) => [p.a.agent_id, p.b.agent_id])).toEqual([[A, B]]);
	});

	it('caps the number of duels per window', () => {
		const ids = Array.from({ length: 8 }, (_, i) => `${String(i + 1).repeat(8)}-0000-4000-8000-000000000000`);
		const rivalries = ids.slice(1).map((id, i) => riv(ids[i], id));
		expect(D.planDuels(rivalries)).toHaveLength(D.DUEL_RULES.max_per_window);
		expect(D.planDuels(rivalries, { max: 5 })).toHaveLength(5);
	});

	it('returns nothing from an empty or missing board', () => {
		expect(D.planDuels([])).toEqual([]);
		expect(D.planDuels(undefined)).toEqual([]);
	});
});

describe('decideDuel (resolution)', () => {
	const side = (closed, pnl) => ({ eligible: true, closed, pnl_lamports: String(pnl) });

	it('awards the side that booked more realized P&L', () => {
		expect(D.decideDuel({ a: side(3, 500_000_000), b: side(4, 200_000_000) })).toEqual({ status: 'resolved', winner: 'a', void_reason: null });
		expect(D.decideDuel({ a: side(3, -500), b: side(1, -100) }).winner).toBe('b');
	});

	it('voids a tie and refunds', () => {
		expect(D.decideDuel({ a: side(2, 1000), b: side(5, 1000) })).toEqual({ status: 'void', winner: null, void_reason: 'tie' });
	});

	it('voids when neither trader closed a trade in the window', () => {
		expect(D.decideDuel({ a: side(0, 0), b: side(0, 0) }).void_reason).toBe('no_trades');
	});

	it('scores an idle trader as flat: beats a loser, loses to a winner', () => {
		expect(D.decideDuel({ a: side(0, 0), b: side(2, -10) }).winner).toBe('a');
		expect(D.decideDuel({ a: side(0, 0), b: side(2, 10) }).winner).toBe('b');
		expect(D.decideDuel({ a: side(3, 0), b: side(0, 0) }).void_reason).toBe('tie');
	});

	it('voids when either trader is private or deleted, whatever the numbers', () => {
		expect(D.decideDuel({ a: { ...side(5, 9e9), eligible: false }, b: side(1, 1) }).void_reason).toBe('trader_unavailable');
		expect(D.decideDuel({ a: side(5, 1), b: { eligible: false } }).void_reason).toBe('trader_unavailable');
	});

	it('compares lamports exactly, beyond float precision', () => {
		const r = D.decideDuel({ a: side(1, '9007199254740993'), b: side(1, '9007199254740992') });
		expect(r.winner).toBe('a');
	});
});

describe('settleCall + callNet (points accounting)', () => {
	const resolved = { status: 'resolved', winner: 'a' };

	it('returns twice the stake on a correct call and nothing on a wrong one', () => {
		expect(D.settleCall({ side: 'a', stake: 40 }, resolved)).toEqual({ status: 'won', payout: 80 });
		expect(D.settleCall({ side: 'b', stake: 40 }, resolved)).toEqual({ status: 'lost', payout: 0 });
	});

	it('refunds the stake on a void duel', () => {
		expect(D.settleCall({ side: 'b', stake: 25 }, { status: 'void' })).toEqual({ status: 'refunded', payout: 25 });
	});

	it('leaves a call open while its duel is open', () => {
		expect(D.settleCall({ side: 'a', stake: 25 }, { status: 'open' })).toEqual({ status: 'open', payout: 0 });
	});

	it('nets a call the way the season board does', () => {
		expect(D.callNet({ status: 'won', stake: 30, payout: 60 })).toBe(30);
		expect(D.callNet({ status: 'lost', stake: 30, payout: 0 })).toBe(-30);
		expect(D.callNet({ status: 'refunded', stake: 30, payout: 30 })).toBe(0);
		expect(D.callNet({ status: 'open', stake: 30, payout: 0 })).toBe(0);
	});
});

describe('validateCall', () => {
	it('accepts a whole stake inside the bounds and the balance', () => {
		expect(D.validateCall({ side: 'a', stake: 10, balance: 100 })).toEqual({ ok: true, side: 'a', stake: 10 });
		expect(D.validateCall({ side: 'b', stake: '100', balance: 100 })).toEqual({ ok: true, side: 'b', stake: 100 });
	});

	it('refuses a bad side, a stake out of bounds or fractional, and an overdraft', () => {
		expect(D.validateCall({ side: 'c', stake: 20 }).code).toBe('invalid_side');
		expect(D.validateCall({ side: 'a', stake: 9 }).code).toBe('invalid_stake');
		expect(D.validateCall({ side: 'a', stake: 101 }).code).toBe('invalid_stake');
		expect(D.validateCall({ side: 'a', stake: 12.5 }).code).toBe('invalid_stake');
		expect(D.validateCall({ side: 'a', stake: 50, balance: 40 }).code).toBe('not_enough_points');
	});
});

describe('duelBadgesFor', () => {
	const pick = (status, day) => ({ status, settled_at: `2026-10-${String(day).padStart(2, '0')}T01:00:00Z` });

	it('earns First Call on any call, even one still open', () => {
		expect(D.duelBadgesFor([{ status: 'open', created_at: '2026-10-01T00:00:00Z' }])).toEqual([BADGES.DUEL_FIRST]);
		expect(D.duelBadgesFor([])).toEqual([]);
	});

	it('earns Called It on the first correct call', () => {
		expect(D.duelBadgesFor([pick('lost', 1), pick('won', 2)])).toContain(BADGES.DUEL_HIT);
	});

	it('needs three correct decided calls in a row for Hot Hand; refunds do not break or extend a run', () => {
		expect(D.duelBadgesFor([pick('won', 1), pick('won', 2), pick('lost', 3), pick('won', 4)])).not.toContain(BADGES.DUEL_STREAK_3);
		expect(D.duelBadgesFor([pick('won', 1), pick('refunded', 2), pick('won', 3), pick('won', 4)])).toContain(BADGES.DUEL_STREAK_3);
		expect(D.duelBadgesFor([pick('won', 3), pick('won', 1), pick('won', 2)])).toContain(BADGES.DUEL_STREAK_3);
	});

	it('needs ten decided calls at 70% or better for Sharp Caller', () => {
		const seven = [...Array(7)].map((_, i) => pick('won', i + 1)).concat([pick('lost', 8), pick('lost', 9), pick('lost', 10)]);
		expect(D.duelBadgesFor(seven)).toContain(BADGES.DUEL_SHARP);
		const six = [...Array(6)].map((_, i) => pick('won', i + 1)).concat([...Array(4)].map((_, i) => pick('lost', i + 7)));
		expect(D.duelBadgesFor(six)).not.toContain(BADGES.DUEL_SHARP);
		expect(D.duelBadgesFor([...Array(9)].map((_, i) => pick('won', i + 1)))).not.toContain(BADGES.DUEL_SHARP);
	});
});

describe('seasons', () => {
	it('is a UTC calendar month', () => {
		const s = D.seasonFor(Date.parse('2026-10-31T23:59:59Z'));
		expect(s).toMatchObject({ id: '2026-10', start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z', label: 'October 2026' });
		expect(D.seasonById('2026-12').end).toBe('2027-01-01T00:00:00.000Z');
		expect(D.seasonById('2026-13')).toBeNull();
		expect(D.seasonById('nope')).toBeNull();
	});
});

// ── database paths ──────────────────────────────────────────────────────────

const openMarket = (over = {}) => ({
	id: MARKET,
	network: 'mainnet',
	window_kind: 'day',
	window_start: new Date(Date.now() + 3_600_000).toISOString(),
	window_end: new Date(Date.now() + 25 * 3_600_000).toISOString(),
	agent_a: A,
	agent_b: B,
	agent_a_name: 'Alpha',
	agent_b_name: 'Bravo',
	status: 'open',
	...over,
});
const agents = (over = {}) => [
	{ id: A, user_id: OWNER_A, name: 'Alpha', is_public: true, deleted_at: null, ...(over.a || {}) },
	{ id: B, user_id: OWNER_B, name: 'Bravo', is_public: true, deleted_at: null, ...(over.b || {}) },
];

function callRoutes({ market = openMarket(), agentRows = agents(), balance = 100, insert = null } = {}) {
	return (q) => {
		if (/from duel_markets where id =/.test(q)) return market ? [market] : [];
		if (/from agent_identities where id = any/.test(q)) return agentRows;
		if (/insert into duel_points_ledger \(user_id, kind, amount, day\)/.test(q)) return [];
		if (/select balance from duel_wallets/.test(q)) return [{ balance }];
		if (/insert into duel_picks/.test(q)) {
			if (insert instanceof Error) throw insert;
			return insert || [{ id: 9, side: 'a', stake: 20, created_at: '2026-09-30T00:00:00Z', balance: balance - 20 }];
		}
		return [];
	};
}

describe('placeCall (abuse rules)', () => {
	it('places a call, debits the stake and unlocks First Call', async () => {
		route = callRoutes();
		const r = await D.placeCall({ userId: USER, marketId: MARKET, side: 'a', stake: 20 });
		expect(r.ok).toBe(true);
		expect(r.balance).toBe(80);
		expect(r.call).toMatchObject({ side: 'a', stake: 20, status: 'open' });
		expect(unlocked).toContainEqual({ userId: USER, code: BADGES.DUEL_FIRST });
		const insert = queries.find((x) => /insert into duel_picks/.test(x.q));
		// The lock, the owner rule and the availability rule are enforced inside the insert too.
		expect(insert.q).toMatch(/m\.window_start > now\(\)/);
		expect(insert.q).toMatch(/a\.user_id = \?/);
		expect(insert.q).toMatch(/is_public = false/);
	});

	it('refuses a call on a duel featuring an agent the caller owns', async () => {
		route = callRoutes({ agentRows: agents({ b: { user_id: USER } }) });
		const r = await D.placeCall({ userId: USER, marketId: MARKET, side: 'a', stake: 20 });
		expect(r).toMatchObject({ ok: false, status: 403, code: 'own_agent' });
		expect(queries.some((x) => /insert into duel_picks/.test(x.q))).toBe(false);
	});

	it('refuses a call once the window has started', async () => {
		route = callRoutes({ market: openMarket({ window_start: new Date(Date.now() - 1000).toISOString() }) });
		const r = await D.placeCall({ userId: USER, marketId: MARKET, side: 'b', stake: 20 });
		expect(r).toMatchObject({ ok: false, status: 409, code: 'duel_locked' });
	});

	it('refuses a call when a trader went private or was deleted', async () => {
		route = callRoutes({ agentRows: agents({ a: { is_public: false } }) });
		expect(await D.placeCall({ userId: USER, marketId: MARKET, side: 'a', stake: 20 })).toMatchObject({ code: 'duel_unavailable' });
		route = callRoutes({ agentRows: agents({ b: { deleted_at: '2026-09-30T00:00:00Z' } }) });
		expect(await D.placeCall({ userId: USER, marketId: MARKET, side: 'a', stake: 20 })).toMatchObject({ code: 'duel_unavailable' });
	});

	it('allows one call per user per duel', async () => {
		route = callRoutes({ insert: Object.assign(new Error('duplicate key'), { code: '23505' }) });
		expect(await D.placeCall({ userId: USER, marketId: MARKET, side: 'a', stake: 20 })).toMatchObject({ status: 409, code: 'already_called' });
	});

	it('refuses a stake above the balance, before and inside the statement', async () => {
		route = callRoutes({ balance: 15 });
		expect(await D.placeCall({ userId: USER, marketId: MARKET, side: 'a', stake: 20 })).toMatchObject({ code: 'not_enough_points' });
		route = callRoutes({ insert: Object.assign(new Error('violates check constraint'), { code: '23514' }) });
		expect(await D.placeCall({ userId: USER, marketId: MARKET, side: 'a', stake: 20 })).toMatchObject({ code: 'not_enough_points' });
	});

	it('reports a lock the database clock caught after the pre-check', async () => {
		route = callRoutes({ insert: [] });
		expect(await D.placeCall({ userId: USER, marketId: MARKET, side: 'a', stake: 20 })).toMatchObject({ code: 'duel_locked' });
	});

	it('rejects a malformed stake or duel id without touching the database', async () => {
		expect(await D.placeCall({ userId: USER, marketId: MARKET, side: 'a', stake: 500 })).toMatchObject({ status: 400, code: 'invalid_stake' });
		expect(await D.placeCall({ userId: USER, marketId: 'nope', side: 'a', stake: 20 })).toMatchObject({ status: 404 });
		expect(queries).toHaveLength(0);
	});
});

describe('resolveDuel (from the ledger)', () => {
	const closedMarket = openMarket({
		window_start: '2026-09-28T00:00:00Z',
		window_end: '2026-09-29T00:00:00Z',
	});
	const now = Date.parse('2026-09-29T00:30:00Z');
	const pos = (pnl, closedAt = '2026-09-28T12:00:00Z', mint = 'THREEsynthetic1111') => ({
		id: Math.random(), status: 'closed', mint, realized_pnl_lamports: String(pnl), realized_pnl_pct: pnl > 0 ? 10 : -10,
		entry_quote_lamports: '100000000', opened_at: '2026-09-28T11:00:00Z', closed_at: closedAt,
	});

	function resolveRoutes({ agentRows = agents(), a = [], b = [], selfDeal = {} } = {}) {
		const updates = [];
		return {
			updates,
			fn: (q, values) => {
				if (/from agent_identities where id = any/.test(q)) return agentRows;
				if (/from agent_sniper_positions p/.test(q)) return values[0] === A ? a : b;
				if (/from agent_strategy_positions s/.test(q)) return [];
				if (/from pump_agent_mints/.test(q)) return (selfDeal[values[0]] || []).map((mint) => ({ mint }));
				if (/update duel_markets set/.test(q)) {
					updates.push(values);
					return [{ id: MARKET }];
				}
				if (/select distinct user_id from duel_picks/.test(q)) return [{ user_id: USER }];
				if (/select status, settled_at, created_at from duel_picks/.test(q)) return [{ status: 'won', settled_at: '2026-09-29T00:30:00Z' }];
				return [];
			},
		};
	}

	it('resolves to the trader with more realized P&L and settles the calls', async () => {
		const r = resolveRoutes({ a: [pos(300_000_000), pos(-100_000_000)], b: [pos(150_000_000)] });
		route = r.fn;
		const out = await D.resolveDuel(closedMarket, { now });
		expect(out).toMatchObject({ status: 'resolved', winner: 'a' });
		expect(r.updates[0].slice(0, 3)).toEqual(['resolved', 'a', null]);
		const result = JSON.parse(r.updates[0][3]);
		expect(result.a).toMatchObject({ closed: 2, wins: 1, pnl_lamports: '200000000' });
		expect(result.b).toMatchObject({ closed: 1, pnl_lamports: '150000000' });
		expect(queries.some((x) => /update duel_picks k set/.test(x.q))).toBe(true);
		expect(queries.some((x) => /insert into trading_quest_completions/.test(x.q))).toBe(true);
		expect(unlocked).toContainEqual({ userId: USER, code: BADGES.DUEL_HIT });
	});

	it('does not credit round-trips on a trader\'s own coin, like the trader card', async () => {
		const r = resolveRoutes({
			a: [pos(900_000_000, undefined, 'THREEsyntheticOWN1')],
			b: [pos(10_000_000)],
			selfDeal: { [OWNER_A]: ['THREEsyntheticOWN1'] },
		});
		route = r.fn;
		const out = await D.resolveDuel(closedMarket, { now });
		expect(out.winner).toBe('b');
	});

	it('voids a tie and a window with no trades on either side', async () => {
		route = resolveRoutes({ a: [pos(5)], b: [pos(5)] }).fn;
		expect(await D.resolveDuel(closedMarket, { now })).toMatchObject({ status: 'void', void_reason: 'tie' });
		route = resolveRoutes().fn;
		expect(await D.resolveDuel(closedMarket, { now })).toMatchObject({ status: 'void', void_reason: 'no_trades' });
	});

	it('voids early, before the window closes, when a trader goes private, without measuring', async () => {
		const r = resolveRoutes({ agentRows: agents({ a: { is_public: false } }) });
		route = r.fn;
		const out = await D.resolveDuel(openMarket(), { now: Date.now() });
		expect(out).toMatchObject({ status: 'void', void_reason: 'trader_unavailable' });
		expect(queries.some((x) => /agent_sniper_positions/.test(x.q))).toBe(false);
		// The refund runs through the same settlement statement.
		expect(queries.some((x) => /update duel_picks k set/.test(x.q))).toBe(true);
	});

	it('leaves a healthy duel alone until its window closes', async () => {
		route = resolveRoutes().fn;
		expect(await D.resolveDuel(openMarket(), { now: Date.now() })).toBeNull();
		expect(queries.some((x) => /update duel_markets/.test(x.q))).toBe(false);
	});

	it('does not settle twice when a concurrent tick already flipped the duel', async () => {
		const r = resolveRoutes({ a: [pos(10)], b: [pos(5)] });
		route = (q, v) => (/update duel_markets set/.test(q) ? [] : r.fn(q, v));
		expect(await D.resolveDuel(closedMarket, { now })).toBeNull();
		expect(queries.some((x) => /update duel_picks k set/.test(x.q))).toBe(false);
	});
});

describe('settlement SQL matches settleCall', () => {
	it('pays the multiplier, refunds voids, and credits XP only for correct calls on resolved duels', async () => {
		route = () => [];
		await D.settleDuelPicks(MARKET);
		const settle = queries.find((x) => /update duel_picks k set/.test(x.q));
		expect(settle.q).toMatch(/when m\.status = 'void' then 'refunded'/);
		expect(settle.q).toMatch(/when m\.status = 'void' then k\.stake/);
		expect(settle.values).toContain(D.DUEL_RULES.win_multiplier);
		expect(settle.q).toMatch(/on conflict do nothing/);
		expect(settle.q).toMatch(/k\.status = 'open'/);
		const xp = queries.find((x) => /insert into trading_quest_completions/.test(x.q));
		expect(xp.q).toMatch(/k\.status = 'won' and m\.status = 'resolved'/);
		expect(xp.values).toContain(D.XP_CODE_PREFIX);
		expect(xp.values).toContain(D.DUEL_RULES.xp_per_win);
	});
});

describe('ensureDailyGrant', () => {
	it('credits the allowance once per UTC day', async () => {
		route = (q) => (/insert into duel_points_ledger/.test(q) ? [{ balance: 100 }] : []);
		expect(await D.ensureDailyGrant(USER, Date.parse('2026-09-30T08:00:00Z'))).toEqual({ balance: 100, granted: true });
		const grant = queries.find((x) => /insert into duel_points_ledger/.test(x.q));
		expect(grant.values).toContain('2026-09-30');
		expect(grant.values).toContain(D.DUEL_RULES.daily_allowance);

		route = (q) => (/select balance from duel_wallets/.test(q) ? [{ balance: 40 }] : []);
		expect(await D.ensureDailyGrant(USER)).toEqual({ balance: 40, granted: false });
	});
});

/**
 * Syndicates (api/_lib/syndicates.js): named teams of copiers over the existing
 * copy loop. The pure halves (naming, validation, the group curve, standings)
 * and the two money-adjacent writes, join and leave, which must:
 *
 *   - create subscriptions ONLY through the guarded subscribe path, with the
 *     member's own caps, and link (never overwrite) a subscription the member
 *     already had;
 *   - refuse a member who runs one of the leaders (self-copy) and a member who
 *     is already on another team;
 *   - roll back cleanly when a follow fails midway, so a join is all or nothing;
 *   - on leave, stop only what the join created.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const SYN = '99999999-9999-4999-8999-999999999999';
const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const USER = 'user-copier';
const WALLET = 'THREEsyntheticWa11et111111111111111111111';

let db;
const sqlCalls = [];

function resetDb() {
	db = {
		syndicate: { id: SYN, slug: 'night-shift', name: 'Night Shift', status: 'active', network: 'mainnet', founder_user_id: 'founder-1' },
		leaders: [
			{ leader_agent_id: L1, position: 0, user_id: 'owner-a', name: 'Alpha', is_public: true, deleted_at: null },
			{ leader_agent_id: L2, position: 1, user_id: 'owner-b', name: 'Beta', is_public: true, deleted_at: null },
		],
		current: [],
		existingSubs: [],
		memberInsert: () => [{ id: 'member-1' }],
		links: [],
		stopped: [],
		deletedMembers: [],
	};
}

vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const text = strings.join('?');
		sqlCalls.push({ text, values });
		if (text.includes('from copy_syndicates s') && text.includes('left join users u')) return Promise.resolve(db.syndicate ? [db.syndicate] : []);
		if (text.includes('from copy_syndicate_leaders l') && text.includes('join agent_identities a')) return Promise.resolve(db.leaders);
		if (text.includes('from copy_syndicate_members m') && text.includes('join copy_syndicates cs') && text.includes('limit 1')) return Promise.resolve(db.current);
		if (text.includes('select id, leader_agent_id, status from copy_subscriptions')) return Promise.resolve(db.existingSubs);
		if (text.includes('insert into copy_syndicate_members')) {
			try { return Promise.resolve(db.memberInsert()); } catch (e) { return Promise.reject(e); }
		}
		if (text.includes('insert into copy_syndicate_member_subs')) {
			db.links.push({ subscription_id: values[1], created_by_join: text.includes('true') });
			return Promise.resolve([]);
		}
		if (text.includes("update copy_subscriptions set status = 'stopped'")) {
			db.stopped.push(...values[0]);
			return Promise.resolve(values[0].map((id) => ({ id })));
		}
		if (text.includes('delete from copy_syndicate_members')) { db.deletedMembers.push(values[0]); return Promise.resolve([]); }
		if (text.includes('select id from copy_syndicate_members')) return Promise.resolve(db.activeMember || []);
		if (text.includes('select subscription_id, created_by_join from copy_syndicate_member_subs')) return Promise.resolve(db.memberLinks || []);
		if (text.includes("update copy_syndicate_members set status = 'left'")) return Promise.resolve([]);
		return Promise.resolve([]);
	},
}));

vi.mock('../api/_lib/streaks.js', () => ({
	unlockBadge: vi.fn(async () => true),
	BADGES: { SYNDICATE_FOUNDER: 'syndicate_founder', SYNDICATE_MEMBER: 'syndicate_member' },
}));

// Every leader clears the bar unless a test says otherwise.
let profiles = {};
vi.mock('../api/_lib/copy-eligibility.js', async (importOriginal) => {
	const real = await importOriginal();
	return { ...real, leaderCopyProfile: async (id) => profiles[id] ?? { settled: 30, span_hours: 200, deployed_sol: 2, max_drawdown_pct: 10 } };
});

const subscribeCopier = vi.fn();
vi.mock('../api/_lib/copy-subscribe.js', async (importOriginal) => {
	const real = await importOriginal();
	return { ...real, subscribeCopier: (...args) => subscribeCopier(...args) };
});

const S = await import('../api/_lib/syndicates.js');

const joinBody = (over = {}) => ({
	copier_wallet: WALLET,
	sizing_rule: 'fixed',
	fixed_sol: 0.1,
	per_trade_cap_sol: 0.5,
	daily_budget_sol: 1,
	...over,
});

beforeEach(() => {
	resetDb();
	profiles = {};
	sqlCalls.length = 0;
	subscribeCopier.mockReset();
	subscribeCopier.mockImplementation(async ({ body }) => ({ ok: true, subscription: { id: `sub-${body.leader_agent_id}` } }));
});

describe('slugifyName', () => {
	it('turns a name into a clean url slug', () => {
		expect(S.slugifyName('Night Shift Degens!')).toBe('night-shift-degens');
		expect(S.slugifyName('  Café  Crème  ')).toBe('cafe-creme');
	});
	it('refuses names with too little to address', () => {
		expect(S.slugifyName('!!')).toBeNull();
		expect(S.slugifyName('a')).toBeNull();
	});
});

describe('validateSyndicateInput', () => {
	const base = { name: 'Night Shift', color: '#22d3ee', leader_agent_ids: [L1] };
	it('accepts a valid founding and dedupes leaders', () => {
		const v = S.validateSyndicateInput({ ...base, leader_agent_ids: [L1, L1, L2] });
		expect(v.ok).toBe(true);
		expect(v.value.leader_agent_ids).toEqual([L1, L2]);
		expect(v.value.slug).toBe('night-shift');
		expect(v.value.network).toBe('mainnet');
	});
	it('caps the leader set at three', () => {
		const four = [L1, L2, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
		expect(S.validateSyndicateInput({ ...base, leader_agent_ids: four }).ok).toBe(false);
	});
	it('requires a palette color and at least one leader', () => {
		expect(S.validateSyndicateInput({ ...base, color: '#123456' }).ok).toBe(false);
		expect(S.validateSyndicateInput({ ...base, leader_agent_ids: [] }).ok).toBe(false);
	});
	it('reserves slugs that name an API route', () => {
		expect(S.validateSyndicateInput({ ...base, name: 'Leaders' }).error).toMatch(/reserved/);
		expect(S.validateSyndicateInput({ ...base, name: 'Membership' }).ok).toBe(false);
	});
	it('bounds the motto', () => {
		expect(S.validateSyndicateInput({ ...base, motto: 'x'.repeat(141) }).ok).toBe(false);
		expect(S.validateSyndicateInput({ ...base, motto: '   ' }).value.motto).toBeNull();
	});
});

describe('buildGroupCurve', () => {
	it('accumulates realized copy profit in close order and tracks peak and trough', () => {
		const c = S.buildGroupCurve([
			{ closed_at: '2026-09-01T00:00:00Z', profit_sol: 0.05 },
			{ closed_at: '2026-09-02T00:00:00Z', profit_sol: -0.12 },
			{ closed_at: '2026-09-03T00:00:00Z', profit_sol: 0.03 },
		]);
		expect(c.points.map((p) => p.cum_sol)).toEqual([0.05, -0.07, -0.04]);
		expect(c.peak_sol).toBe(0.05);
		expect(c.trough_sol).toBe(-0.07);
		expect(c.final_sol).toBe(-0.04);
	});
	it('thins a long curve but always keeps the final point', () => {
		const rows = Array.from({ length: 500 }, (_, i) => ({ closed_at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), profit_sol: 0.001 }));
		const c = S.buildGroupCurve(rows, 50);
		expect(c.points).toHaveLength(50);
		expect(c.points.at(-1).cum_sol).toBe(c.final_sol);
		expect(c.final_sol).toBeCloseTo(0.5, 6);
	});
	it('is empty, not zero-filled, with no closed copies', () => {
		expect(S.buildGroupCurve([]).points).toEqual([]);
	});
});

describe('shapeBoardRow and computeStanding', () => {
	const row = (id, rank, profit) => S.shapeBoardRow({
		id, slug: id, name: id.toUpperCase(), color: '#7c5cff', network: 'mainnet', created_at: '2026-09-01T00:00:00Z',
		members: '3', intents: '4', acted: '2', copied_sol: '0.4', profit_sol: String(profit), closed_copies: '2', winning_copies: '1',
		leaders: [{ agent_id: L1, name: null, image: null }], official: false,
		leader_closes: '5', leader_pnl_lamports: '250000000', leader_entry_lamports: '1000000000', rank: String(rank),
	});

	it('shapes numbers from the aggregate query', () => {
		const r = row('a', 1, 0.2);
		expect(r.members).toBe(3);
		expect(r.performance.win_rate_pct).toBe(50);
		expect(r.since_founding).toEqual({ leader_closes: 5, leader_pnl_sol: 0.25, leader_roi_pct: 25 });
		expect(r.leaders[0].name).toBe('Unnamed trader');
		expect(r.url).toBe('/syndicates/a');
	});

	it('names the syndicate one rank ahead as the rival', () => {
		const s = S.computeStanding([row('a', 1, 0.5), row('b', 2, 0.2), row('c', 3, 0.1)], 'b', 3);
		expect(s.rank).toBe(2);
		expect(s.rival).toMatchObject({ slug: 'a', direction: 'ahead', gap_sol: 0.3 });
	});

	it('gives the board leader the chaser behind it', () => {
		const s = S.computeStanding([row('a', 1, 0.5), row('b', 2, 0.2)], 'a', 2);
		expect(s.rival).toMatchObject({ slug: 'b', direction: 'behind' });
	});

	it('has no rival when alone on the board', () => {
		expect(S.computeStanding([row('a', 1, 0)], 'a', 1)).toEqual({ rank: 1, total: 1, rival: null });
	});
});

describe('joinSyndicate', () => {
	it('creates one guarded subscription per leader with the member\'s own caps', async () => {
		const r = await S.joinSyndicate({ userId: USER, slug: 'night-shift', body: joinBody({ max_drawdown_pct: 30 }) });
		expect(r.ok).toBe(true);
		expect(subscribeCopier).toHaveBeenCalledTimes(2);
		const firstBody = subscribeCopier.mock.calls[0][0].body;
		expect(firstBody).toMatchObject({ leader_agent_id: L1, network: 'mainnet', copier_wallet: WALLET, per_trade_cap_sol: 0.5, max_drawdown_pct: 30 });
		expect(db.links).toEqual([
			{ subscription_id: `sub-${L1}`, created_by_join: true },
			{ subscription_id: `sub-${L2}`, created_by_join: true },
		]);
	});

	it('links a subscription the member already had instead of overwriting its caps', async () => {
		db.existingSubs = [{ id: 'mine-before', leader_agent_id: L1, status: 'active' }];
		const r = await S.joinSyndicate({ userId: USER, slug: 'night-shift', body: joinBody() });
		expect(r.ok).toBe(true);
		expect(subscribeCopier).toHaveBeenCalledTimes(1);
		expect(subscribeCopier.mock.calls[0][0].body.leader_agent_id).toBe(L2);
		expect(db.links[0]).toEqual({ subscription_id: 'mine-before', created_by_join: false });
	});

	it('re-subscribes a leader the member had stopped, as a new follow', async () => {
		db.existingSubs = [{ id: 'old-stopped', leader_agent_id: L1, status: 'stopped' }];
		await S.joinSyndicate({ userId: USER, slug: 'night-shift', body: joinBody() });
		expect(subscribeCopier).toHaveBeenCalledTimes(2);
	});

	it('refuses a member who runs one of the leaders', async () => {
		const r = await S.joinSyndicate({ userId: 'owner-b', slug: 'night-shift', body: joinBody() });
		expect(r).toMatchObject({ ok: false, status: 403, code: 'self_copy' });
		expect(subscribeCopier).not.toHaveBeenCalled();
	});

	it('refuses a member already on another team and names it', async () => {
		db.current = [{ id: 'm-x', syndicate_id: 'other', slug: 'curve-chasers', name: 'Curve Chasers' }];
		const r = await S.joinSyndicate({ userId: USER, slug: 'night-shift', body: joinBody() });
		expect(r).toMatchObject({ ok: false, status: 409, code: 'already_in_syndicate' });
		expect(r.extra.current.slug).toBe('curve-chasers');
	});

	it('changes nothing when a leader has lost its copyable record', async () => {
		profiles[L2] = { settled: 1, span_hours: 0, deployed_sol: 0.001, max_drawdown_pct: null };
		const r = await S.joinSyndicate({ userId: USER, slug: 'night-shift', body: joinBody() });
		expect(r).toMatchObject({ ok: false, status: 409, code: 'leader_not_copyable' });
		expect(r.extra.leaders[0].agent_id).toBe(L2);
		expect(sqlCalls.some((c) => c.text.includes('insert into copy_syndicate_members'))).toBe(false);
		expect(subscribeCopier).not.toHaveBeenCalled();
	});

	it('rolls back the membership and any follow it made when a later follow fails', async () => {
		subscribeCopier.mockImplementation(async ({ body }) => (
			body.leader_agent_id === L2
				? { ok: false, status: 409, code: 'leader_not_copyable', message: 'no', extra: {} }
				: { ok: true, subscription: { id: `sub-${body.leader_agent_id}` } }
		));
		const r = await S.joinSyndicate({ userId: USER, slug: 'night-shift', body: joinBody() });
		expect(r.ok).toBe(false);
		expect(db.stopped).toEqual([`sub-${L1}`]);
		expect(db.deletedMembers).toEqual(['member-1']);
	});

	it('maps a concurrent join racing the one-team index to a clean conflict', async () => {
		db.memberInsert = () => { throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }); };
		const r = await S.joinSyndicate({ userId: USER, slug: 'night-shift', body: joinBody() });
		expect(r).toMatchObject({ ok: false, status: 409, code: 'already_in_syndicate' });
	});

	it('validates the wallet and caps before touching the database', async () => {
		expect((await S.joinSyndicate({ userId: USER, slug: 'night-shift', body: joinBody({ copier_wallet: 'nope' }) })).code).toBe('invalid_wallet');
		expect((await S.joinSyndicate({ userId: USER, slug: 'night-shift', body: joinBody({ per_trade_cap_sol: 0 }) })).code).toBe('invalid_config');
		expect(sqlCalls).toHaveLength(0);
	});
});

describe('leaveSyndicate', () => {
	it('stops only the subscriptions the join created', async () => {
		db.activeMember = [{ id: 'member-1' }];
		db.memberLinks = [
			{ subscription_id: 'made-by-join', created_by_join: true },
			{ subscription_id: 'had-before', created_by_join: false },
		];
		const r = await S.leaveSyndicate({ userId: USER, slug: 'night-shift' });
		expect(r).toEqual({ ok: true, stopped_subscriptions: ['made-by-join'], kept_subscriptions: ['had-before'] });
		expect(db.stopped).toEqual(['made-by-join']);
	});

	it('says so when the user is not a member', async () => {
		db.activeMember = [];
		expect(await S.leaveSyndicate({ userId: USER, slug: 'night-shift' })).toMatchObject({ ok: false, status: 404, code: 'not_member' });
	});
});

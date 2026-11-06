// Unit tests for the server-side access-control gate, hasSkillAccess().
//
// This is the authoritative "may user X execute skill Y on agent Z?" check used
// by the skill execution endpoint. It grants access through any one of: free
// skill, confirmed purchase, flat agent subscription, creator-tier subscription
// whose included_skills covers the skill, or an active trial — checked in that
// priority order so a trial is never burned when something stronger applies.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// db.js is mocked with an ordered queue: each `sql\`...\`` shifts the next row
// set. hasSkillAccess issues its queries in a fixed order — price, purchase,
// flat subscription, tier subscription — so tests push exactly what each path
// will read.
const sqlState = { queue: [], calls: [] };

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { hasSkillAccess, consumeTrialUse } = await import('../../api/_lib/skill-access.js');

const USER = 'user-1';
const AGENT = 'agent-1';
const SKILL = 'translate';
const PRICE = { skill: SKILL, amount: 1000, currency_mint: 'USDC', chain: 'solana' };

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
});

describe('hasSkillAccess', () => {
	it('allows a free skill (no active price row)', async () => {
		sqlState.queue.push([]); // price lookup → none
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toEqual({ paid: false, owned: true });
		expect(sqlState.calls).toHaveLength(1); // short-circuits after price lookup
	});

	it('denies a priced skill for an anonymous (no userId) caller', async () => {
		sqlState.queue.push([PRICE]);
		const r = await hasSkillAccess(null, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: false, reason: 'not_purchased' });
		expect(r.price).toEqual(PRICE);
		expect(sqlState.calls).toHaveLength(1); // no purchase/sub queries without a user
	});

	it('allows a confirmed one-time purchase without touching subscriptions', async () => {
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([{ status: 'confirmed', valid_until: null, trial_remaining: null }]);
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: true });
		expect(r.via_subscription).toBeUndefined();
		expect(r.trial).toBeUndefined();
		// price + purchase only — subscriptions are not consulted once owned.
		expect(sqlState.calls).toHaveLength(2);
	});

	it('honours a confirmed time-pass that is still valid', async () => {
		const future = new Date(Date.now() + 3600_000).toISOString();
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([{ status: 'confirmed', valid_until: future }]);
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: true });
	});

	it('denies an expired time-pass when no subscription covers the skill', async () => {
		const past = new Date(Date.now() - 3600_000).toISOString();
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([{ status: 'confirmed', valid_until: past }]);
		sqlState.queue.push([]); // flat subscription → none
		sqlState.queue.push([]); // tier subscription → none
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: false, reason: 'expired' });
	});

	it('allows access via a flat agent-level subscription', async () => {
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([]); // no purchase
		sqlState.queue.push([{ id: 'flat-sub' }]); // flat subscription active
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: true, via_subscription: true });
	});

	it('allows access via a creator tier whose included_skills covers the skill', async () => {
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([]); // no purchase
		sqlState.queue.push([]); // no flat subscription
		sqlState.queue.push([{ id: 'tier-sub' }]); // tier with skill in included_skills
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: true, via_subscription: true });
	});

	it('denies when a tier subscription exists but does not include this skill', async () => {
		// The tier query filters by `skill = ANY(included_skills)`, so a tier that
		// omits the skill simply returns no row.
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([]); // no purchase
		sqlState.queue.push([]); // no flat subscription
		sqlState.queue.push([]); // tier query → skill not in any included_skills
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: false, reason: 'not_purchased' });
	});

	it('allows an active trial with remaining uses', async () => {
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([{ status: 'trial', trial_remaining: 2 }]);
		sqlState.queue.push([]); // no flat subscription
		sqlState.queue.push([]); // no tier subscription
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: true, trial: true, trial_remaining: 2 });
	});

	it('denies an exhausted trial', async () => {
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([{ status: 'trial', trial_remaining: 0 }]);
		sqlState.queue.push([]); // no flat subscription
		sqlState.queue.push([]); // no tier subscription
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: false, reason: 'trial_exhausted' });
	});

	it('prefers a subscription over burning a trial', async () => {
		// A user holding both a trial and a flat subscription is granted access via
		// the subscription — the trial row is left untouched.
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([{ status: 'trial', trial_remaining: 1 }]);
		sqlState.queue.push([{ id: 'flat-sub' }]); // flat subscription active
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: true, via_subscription: true });
		expect(r.trial).toBeUndefined();
	});

	it('denies when priced and the user has no purchase or subscription', async () => {
		sqlState.queue.push([PRICE]);
		sqlState.queue.push([]); // no purchase
		sqlState.queue.push([]); // no flat subscription
		sqlState.queue.push([]); // no tier subscription
		const r = await hasSkillAccess(USER, AGENT, SKILL);
		expect(r).toMatchObject({ paid: true, owned: false, reason: 'not_purchased' });
	});
});

describe('consumeTrialUse', () => {
	it('returns the decremented remaining count', async () => {
		sqlState.queue.push([{ trial_remaining: 1 }]);
		const remaining = await consumeTrialUse(USER, AGENT, SKILL);
		expect(remaining).toBe(1);
	});

	it('returns null when no trial row matches', async () => {
		sqlState.queue.push([]); // UPDATE … RETURNING matched nothing
		const remaining = await consumeTrialUse(USER, AGENT, SKILL);
		expect(remaining).toBeNull();
	});
});

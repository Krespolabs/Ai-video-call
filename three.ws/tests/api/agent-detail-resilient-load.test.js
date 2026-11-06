// GET /api/agents/:id must survive a failure in its *supplementary* decoration
// steps. The core read is a single agent_identities row; skill pricing and the
// dangling-avatar self-heal are enrichments layered on top. When either throws
// (skill-price cache backend hiccup, a transient error on the avatars probe),
// the endpoint used to 500 — which the agent-detail page renders as the full
// "Couldn't load this agent — problem reaching the registry" error state, even
// though the agent itself loaded fine. These tests pin the degrade-don't-die
// contract: the agent still returns 200, with skill_prices defaulting to {}.
//
// Driven through the real handleGetOne with DB / auth / rate-limit / r2 / cache
// mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '6bf40884-35af-432e-b432-8ba73fb5ba15';

// Content-addressed SQL mock: classify by query text so call order never
// matters. `avatarsThrows` flips the avatars probe (healStaleAvatarId) into a
// rejection to exercise that degrade path independently.
let agentRow = null;
let avatarsThrows = false;
const sqlMock = vi.fn((strings) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/FROM avatars/i.test(q)) {
		if (avatarsThrows) return Promise.reject(new Error('avatars probe failed'));
		return Promise.resolve([{ id: agentRow?.avatar_id }]);
	}
	if (/FROM agent_identities/i.test(q)) return Promise.resolve(agentRow ? [agentRow] : []);
	if (/FROM usage_events/i.test(q)) return Promise.resolve([{ total: 7 }]);
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// The skill-price cache is the primary fault we inject: getSkillPrices rejects.
let skillPricesThrows = true;
vi.mock('../../api/_lib/skill-price-cache.js', () => ({
	getSkillPrices: vi.fn(async () => {
		if (skillPricesThrows) throw new Error('cache backend unreachable');
		return [];
	}),
	skillPriceMap: vi.fn(() => ({})),
}));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => null),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn(() => false),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000, limit: 60, remaining: 59 })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/r2.js', () => ({ publicUrl: (k) => (k ? `https://cdn.test/${k}` : null) }));

// cacheWrap(key, ttl, fn) → run fn so the usage_events count path still exercises
// the mocked sql, but never reaches a real cache backend.
vi.mock('../../api/_lib/cache.js', () => ({
	cacheWrap: vi.fn(async (_key, _ttl, fn) => fn()),
}));

const { handleGetOne } = await import('../../api/agents.js');

function agentFixture(overrides = {}) {
	return {
		id: AGENT_ID,
		name: 'Atlas',
		description: 'A research agent.',
		user_id: 'owner-uuid',
		avatar_id: null,
		meta: {},
		skills: ['research'],
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		...overrides,
	};
}

async function getAgent() {
	const req = makeReq({ method: 'GET', url: `/api/agents/${AGENT_ID}` });
	const res = makeRes();
	await handleGetOne(req, res, AGENT_ID);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	sqlMock.mockClear();
	agentRow = agentFixture();
	avatarsThrows = false;
	skillPricesThrows = true;
});

describe('GET /api/agents/:id — resilient load', () => {
	it('still 200s with skill_prices={} when the skill-price cache throws', async () => {
		const { status, body } = await getAgent();
		expect(status).toBe(200);
		expect(body.agent.id).toBe(AGENT_ID);
		expect(body.agent.name).toBe('Atlas');
		expect(body.agent.skill_prices).toEqual({});
	});

	it('still 200s when the dangling-avatar self-heal probe throws', async () => {
		agentRow = agentFixture({ avatar_id: '99999999-1111-4111-8111-222222222222' });
		avatarsThrows = true;
		skillPricesThrows = false;
		const { status, body } = await getAgent();
		expect(status).toBe(200);
		expect(body.agent.id).toBe(AGENT_ID);
		// avatar_id is left intact rather than nulled when the probe can't run.
		expect(body.agent.avatar_id).toBe('99999999-1111-4111-8111-222222222222');
	});

	it('serves the agent normally when every enrichment succeeds', async () => {
		skillPricesThrows = false;
		const { status, body } = await getAgent();
		expect(status).toBe(200);
		expect(body.agent.chat_count).toBe(7);
		expect(body.agent.skill_prices).toEqual({});
	});
});

// C2 — Skills & services management for an IRL agent.
//
// These are the two endpoints the dashboard Services panel
// (src/dashboard-next/pages/irl-placements.js openServicesModal) drives so an
// owner can attach skills to a placed agent and set the x402 per-call price a
// passer-by then pays (B3):
//
//   POST /api/agent-skill-price?agentId=:id   single-skill upsert (amount=0 deactivates)
//   GET  /api/agents/:id/skills-pricing        read the agent's active prices
//   PUT  /api/agents/:id/skills-pricing        bulk replace the active price set
//
// The server is the trust boundary: ownership is checked against
// agent_identities (never the caller), cookie-session mutations require CSRF, the
// price body is validated, and a pause/remove is recorded as a deactivation
// (is_active=false), never a phantom row. These tests pin that boundary down.
// DB / auth / CSRF / limiter are mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

// ── Content-addressed SQL mock ───────────────────────────────────────────────
// Classify each tagged-template query by its text: the agent-ownership lookup,
// the active-price read, and the write statements (UPDATE deactivate / INSERT
// upsert) each get the right shape regardless of call order. Every call is
// recorded so write-path assertions can verify the persisted atomic amount and
// the deactivate path. `sql.transaction` mirrors postgres.js's array form (the
// tagged calls have already run by the time the array is built, so awaiting them
// in order is faithful).
let agentRow = null;       // agent_identities lookup → { id, user_id } or null
let activePrices = [];     // rows the GET returns
let calls = [];            // { q, values } for every query, in order

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	calls.push({ q, values });
	if (/FROM agent_identities/i.test(q)) {
		return Promise.resolve(agentRow ? [agentRow] : []);
	}
	if (/SELECT[\s\S]*FROM agent_skill_prices[\s\S]*is_active = true/i.test(q)) {
		return Promise.resolve(activePrices);
	}
	// UPDATE (deactivate) / INSERT (upsert) / DDL — no RETURNING is consumed.
	return Promise.resolve([]);
});
sqlMock.transaction = (queries) => Promise.all(queries);
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
let bearerUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => bearerUser),
	extractBearer: vi.fn(() => null),
}));

// CSRF passes by default; flip `csrfOk=false` to exercise the gate. On failure the
// real requireCsrf writes the 403 itself, so the mock does too — the handler just
// returns after a falsy result.
let csrfOk = true;
vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (req, res) => {
		if (csrfOk) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'csrf_invalid' }));
		return false;
	}),
}));

let rlSuccess = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: rlSuccess, reset: Date.now() + 1000, limit: 60, remaining: 0 })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: singleUpsert } = await import('../../api/agent-skill-price.js');
const { default: pricing } = await import('../../api/agents/[id]/skills-pricing.js');

// $THREE and Solana USDC — the only mints the dashboard offers; both base58.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const AGENT_ID = '00000000-0000-4000-8000-000000000abc';

const findCall = (re) => calls.find((c) => re.test(c.q));

beforeEach(() => {
	sqlMock.mockClear();
	calls = [];
	agentRow = { id: AGENT_ID, user_id: 'owner-uuid' };
	activePrices = [];
	sessionUser = null;
	bearerUser = null;
	csrfOk = true;
	rlSuccess = true;
});

// ── POST /api/agent-skill-price — single-skill upsert (the dashboard write) ───
describe('POST /api/agent-skill-price — auth + ownership', () => {
	const url = `/api/agent-skill-price?agentId=${AGENT_ID}`;
	const body = { skill: 'web-search', amount: 50000, currency_mint: THREE_MINT, chain: 'solana' };

	it('401s when unauthenticated', async () => {
		const { status, body: out } = await invoke(singleUpsert, { method: 'POST', url, body });
		expect(status).toBe(401);
		expect(out.error).toBe('unauthorized');
	});

	it('403s when the agent belongs to another user', async () => {
		sessionUser = { id: 'not-the-owner' };
		const { status, body: out } = await invoke(singleUpsert, { method: 'POST', url, body });
		expect(status).toBe(403);
		expect(out.error).toBe('forbidden');
		// Ownership is rejected before any write touches agent_skill_prices.
		expect(findCall(/INTO agent_skill_prices/i)).toBeUndefined();
	});

	it('404s when the agent does not exist', async () => {
		sessionUser = { id: 'owner-uuid' };
		agentRow = null;
		const { status, body: out } = await invoke(singleUpsert, { method: 'POST', url, body });
		expect(status).toBe(404);
		expect(out.error).toBe('not_found');
	});

	it('400s without an agentId query param', async () => {
		sessionUser = { id: 'owner-uuid' };
		const { status } = await invoke(singleUpsert, { method: 'POST', url: '/api/agent-skill-price', body });
		expect(status).toBe(400);
	});

	it('403s when the CSRF token is missing/invalid', async () => {
		sessionUser = { id: 'owner-uuid' };
		csrfOk = false;
		const { status, body: out } = await invoke(singleUpsert, { method: 'POST', url, body });
		expect(status).toBe(403);
		expect(out.error).toBe('csrf_invalid');
	});

	it('429s when rate-limited', async () => {
		sessionUser = { id: 'owner-uuid' };
		rlSuccess = false;
		const { status } = await invoke(singleUpsert, { method: 'POST', url, body });
		expect(status).toBe(429);
	});
});

describe('POST /api/agent-skill-price — validation + persistence', () => {
	const url = `/api/agent-skill-price?agentId=${AGENT_ID}`;
	beforeEach(() => { sessionUser = { id: 'owner-uuid' }; });

	it('400s on a mint that is not base58', async () => {
		const { status, body: out } = await invoke(singleUpsert, {
			method: 'POST', url,
			body: { skill: 'web-search', amount: 50000, currency_mint: 'not-base58!!', chain: 'solana' },
		});
		expect(status).toBe(400);
		expect(out.error).toBe('validation_error');
		expect(findCall(/INTO agent_skill_prices/i)).toBeUndefined();
	});

	it('400s on a non-integer / negative amount', async () => {
		const { status } = await invoke(singleUpsert, {
			method: 'POST', url,
			body: { skill: 'web-search', amount: -5, currency_mint: THREE_MINT, chain: 'solana' },
		});
		expect(status).toBe(400);
	});

	it('writes the atomic price as an active row (0.05 USDC → 50000)', async () => {
		const { status, body: out } = await invoke(singleUpsert, {
			method: 'POST', url,
			body: { skill: 'web-search', amount: 50000, currency_mint: THREE_MINT, chain: 'solana' },
		});
		expect(status).toBe(200);
		expect(out.data.ok).toBe(true);
		const ins = findCall(/INTO agent_skill_prices/i);
		expect(ins).toBeDefined();
		// VALUES (${agentId}, ${skill}, ${amount}, ${currency_mint}, ${chain}, true)
		expect(ins.values[0]).toBe(AGENT_ID);
		expect(ins.values[1]).toBe('web-search');
		expect(ins.values[2]).toBe(50000);
		expect(ins.values[3]).toBe(THREE_MINT);
		// No deactivate ran on a real price.
		expect(findCall(/SET is_active = false/i)).toBeUndefined();
	});

	it('amount=0 deactivates (pause / remove) instead of inserting a row', async () => {
		const { status } = await invoke(singleUpsert, {
			method: 'POST', url,
			body: { skill: 'web-search', amount: 0, currency_mint: THREE_MINT, chain: 'solana' },
		});
		expect(status).toBe(200);
		const deact = findCall(/SET is_active = false/i);
		expect(deact).toBeDefined();
		expect(deact.values).toContain('web-search');
		// A deactivate must never also insert a live row.
		expect(findCall(/INTO agent_skill_prices/i)).toBeUndefined();
	});
});

// ── GET/PUT /api/agents/:id/skills-pricing — read + bulk replace ──────────────
describe('GET /api/agents/:id/skills-pricing', () => {
	const url = `/api/agents/${AGENT_ID}/skills-pricing`;

	it('401s when unauthenticated', async () => {
		const { status } = await invoke(pricing, { method: 'GET', url });
		expect(status).toBe(401);
	});

	it('403s for a non-owner', async () => {
		sessionUser = { id: 'not-the-owner' };
		const { status, body: out } = await invoke(pricing, { method: 'GET', url });
		expect(status).toBe(403);
		expect(out.error).toBe('forbidden');
	});

	it('returns the agent\'s active prices for the owner', async () => {
		sessionUser = { id: 'owner-uuid' };
		activePrices = [
			{ skill: 'web-search', amount: 50000, currency_mint: THREE_MINT, chain: 'solana' },
		];
		const { status, body: out } = await invoke(pricing, { method: 'GET', url });
		expect(status).toBe(200);
		expect(out.prices).toHaveLength(1);
		expect(out.prices[0].skill).toBe('web-search');
		expect(out.prices[0].amount).toBe(50000);
	});
});

describe('PUT /api/agents/:id/skills-pricing — bulk replace', () => {
	const url = `/api/agents/${AGENT_ID}/skills-pricing`;
	beforeEach(() => { sessionUser = { id: 'owner-uuid' }; });

	it('403s when the CSRF token is missing/invalid', async () => {
		csrfOk = false;
		const { status } = await invoke(pricing, {
			method: 'PUT', url,
			body: { prices: [{ skill: 'web-search', amount: 50000, currency_mint: THREE_MINT, chain: 'solana' }] },
		});
		expect(status).toBe(403);
	});

	it('400s on an invalid price (amount below the minimum)', async () => {
		const { status, body: out } = await invoke(pricing, {
			method: 'PUT', url,
			body: { prices: [{ skill: 'web-search', amount: 0, currency_mint: THREE_MINT, chain: 'solana' }] },
		});
		expect(status).toBe(400);
		expect(out.error).toBe('validation_error');
	});

	it('atomically deactivates the old set then upserts the submitted prices', async () => {
		const { status, body: out } = await invoke(pricing, {
			method: 'PUT', url,
			body: { prices: [
				{ skill: 'web-search', amount: 50000, currency_mint: THREE_MINT, chain: 'solana' },
				{ skill: 'summarize',  amount: 100000, currency_mint: THREE_MINT, chain: 'solana' },
			] },
		});
		expect(status).toBe(200);
		expect(out.ok).toBe(true);
		// Deactivate-all runs first, then one upsert per submitted price.
		expect(findCall(/SET is_active = false WHERE agent_id/i)).toBeDefined();
		const inserts = calls.filter((c) => /INTO agent_skill_prices/i.test(c.q));
		expect(inserts).toHaveLength(2);
		expect(inserts.map((c) => c.values[1])).toEqual(['web-search', 'summarize']);
	});
});

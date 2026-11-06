// GET /api/irl/agent-summary?mine=1 — C1 owner dashboard overview.
//
// One round-trip that joins each owned pin to its agent + derived activity so the
// dashboard paints without N blocking calls. The endpoint is the correctness
// boundary for three things the card relies on and that must never 500:
//   • auth — only the signed-in owner's pins, never anyone else's;
//   • graceful degradation — a fresh DB (no irl_pins) or a pre-C4 deploy (no
//     irl_interactions) returns 0 / null instead of throwing;
//   • derived status — expired / online (interaction < 5 min) / visible.
// DB + auth are mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content-addressed SQL mock. The to_regclass probe returns whatever the current
// test set on `reg`; the pin SELECT returns `pinRows`. Which SELECT ran is
// recorded so we can assert the table-existence guard picked the right query.
let reg = { has_pins: true, has_ix: true };
let pinRows = [];
let ranWithIxJoin = false;
const sqlMock = vi.fn((strings) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/to_regclass/i.test(q)) return Promise.resolve([reg]);
	if (/FROM irl_pins p/i.test(q)) {
		ranWithIxJoin = /LEFT JOIN \(\s*SELECT pin_id/i.test(q);
		return Promise.resolve(pinRows);
	}
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: handler } = await import('../../api/irl/agent-summary.js');

function makeReq() {
	return { url: '/api/irl/agent-summary?mine=1', method: 'GET', headers: { host: 'x' }, query: { mine: '1' } };
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}
async function getSummary() {
	const res = makeRes();
	await handler(makeReq(), res);
	let body = null;
	try { body = JSON.parse(res._body); } catch { /* body stays null for a non-JSON response */ }
	return { res, body };
}

// A fixed "now" so online-window math is deterministic without Date mocking:
// build interaction timestamps relative to the moment the test asserts.
const minsAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

beforeEach(() => {
	sqlMock.mockClear();
	ranWithIxJoin = false;
	reg = { has_pins: true, has_ix: true };
	pinRows = [];
	sessionUser = { id: 'owner-uuid' };
});

describe('GET /api/irl/agent-summary — auth gate', () => {
	it('401s an unauthenticated caller and never queries pins', async () => {
		sessionUser = null;
		const { res, body } = await getSummary();
		expect(res.statusCode).toBe(401);
		expect(body.error).toMatch(/not authenticated/i);
		// Only the (possible) probe must not run; no pin SELECT either.
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('GET /api/irl/agent-summary — graceful degradation (never 500)', () => {
	it('returns empty agents when irl_pins does not exist yet', async () => {
		reg = { has_pins: false, has_ix: false };
		const { res, body } = await getSummary();
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({ agents: [] });
		// Guarded out before any pin query.
		expect(sqlMock.mock.calls.some(([s]) => /FROM irl_pins p/i.test(Array.isArray(s) ? s.join(' ') : String(s)))).toBe(false);
	});

	it('runs the NO-interactions query form and zeroes counts when irl_interactions is absent (pre-C4)', async () => {
		reg = { has_pins: true, has_ix: false };
		pinRows = [{
			pin_id: 'pin-1', agent_id: 'agent-1', lat: 1, lng: 2, heading: 0, caption: null,
			avatar_url: '/a.glb', avatar_name: 'Aya', placed_at: minsAgo(60), expires_at: null,
			view_count: 3, agent_name: 'Aya', solana_address: 'THREEsynthetic1111',
			interaction_count: 0, last_interaction_at: null,
		}];
		const { res, body } = await getSummary();
		expect(res.statusCode).toBe(200);
		expect(ranWithIxJoin).toBe(false);                 // took the degraded query path
		expect(body.agents).toHaveLength(1);
		expect(body.agents[0].interaction_count).toBe(0);
		expect(body.agents[0].last_interaction_at).toBeNull();
		expect(body.agents[0].status).toBe('visible');     // live, no activity
	});
});

describe('GET /api/irl/agent-summary — derived status', () => {
	function pin(extra) {
		return {
			pin_id: 'p', agent_id: 'a', lat: 1, lng: 2, heading: 0, caption: null,
			avatar_url: '/a.glb', avatar_name: 'A', placed_at: minsAgo(120), expires_at: null,
			view_count: 0, agent_name: 'A', solana_address: null,
			interaction_count: 0, last_interaction_at: null, ...extra,
		};
	}

	it('joins interaction activity and marks a pin online when touched in the last 5 min', async () => {
		reg = { has_pins: true, has_ix: true };
		pinRows = [pin({ interaction_count: 7, last_interaction_at: minsAgo(2) })];
		const { res, body } = await getSummary();
		expect(res.statusCode).toBe(200);
		expect(ranWithIxJoin).toBe(true);                  // took the joined query path
		expect(body.agents[0].interaction_count).toBe(7);
		expect(body.agents[0].status).toBe('online');
	});

	it('marks a pin visible when its last interaction is older than the online window', async () => {
		pinRows = [pin({ interaction_count: 4, last_interaction_at: minsAgo(30) })];
		const { body } = await getSummary();
		expect(body.agents[0].status).toBe('visible');
	});

	it('marks an expired pin expired even if it had a recent interaction', async () => {
		pinRows = [pin({ expires_at: minsAgo(1), last_interaction_at: minsAgo(1) })];
		const { body } = await getSummary();
		expect(body.agents[0].status).toBe('expired');
	});
});

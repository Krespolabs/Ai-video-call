import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' } }));
// reflection.js (for decorateReflection) pulls in llm.js — stub it so the import
// graph stays light and never touches a real provider.
vi.mock('../api/_lib/llm.js', () => ({ llmComplete: vi.fn(), LlmUnavailableError: class extends Error {} }));

const { default: dreamsHandler } = await import('../api/agent/dreams.js');

function mkReq({ method = 'GET', url = '/api/agent/dreams', headers = {}, body = null } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method, url, headers: hdrs,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._endCb?.(); });
			} else if (event === 'end') this._endCb = cb;
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

const AGENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DREAM = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const MEM = 'mmmmmmmm-mmmm-mmmm-mmmm-mmmmmmmmmmmm';

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue({ id: 'user-1' });
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
});

describe('GET /api/agent/dreams', () => {
	it('returns pending dreams with their cited source memories hydrated', async () => {
		const now = new Date();
		sqlQueue = [
			[{ id: AGENT, user_id: 'user-1' }], // ownership
			[{
				id: DREAM, agent_id: AGENT, status: 'pending', kind: 'belief',
				statement: 'You prefer finality.', rationale: null, confidence: 0.8,
				source_memory_ids: [MEM], proposed_type: 'user', proposed_salience: 0.85,
				proposed_action: null, question: null, answer: null, accepted_memory_id: null,
				created_at: now, reviewed_at: null,
			}], // reflections
			[{ id: MEM, type: 'user', content: 'cares about settlement', salience: 0.6, created_at: now }], // memories
			[{ pending: 1 }], // pending count
			[{ trigger: 'cron', status: 'ok', reason: null, dreams_created: 1, created_at: now }], // lastRun
		];
		const req = mkReq({ url: `/api/agent/dreams?agentId=${AGENT}&status=pending` });
		const res = mkRes();
		await dreamsHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.pending).toBe(1);
		expect(body.dreams).toHaveLength(1);
		expect(body.dreams[0].sources[0]).toMatchObject({ id: MEM, type: 'user' });
		expect(body.lastRun.dreamsCreated).toBe(1);
	});

	it('401s when not signed in', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const req = mkReq({ url: `/api/agent/dreams?agentId=${AGENT}` });
		const res = mkRes();
		await dreamsHandler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('403s when the agent belongs to another user', async () => {
		sqlQueue = [[{ id: AGENT, user_id: 'someone-else' }]];
		const req = mkReq({ url: `/api/agent/dreams?agentId=${AGENT}` });
		const res = mkRes();
		await dreamsHandler(req, res);
		expect(res.statusCode).toBe(403);
	});
});

describe('POST /api/agent/dreams — review', () => {
	it('accept writes a real higher-salience memory and resolves the dream', async () => {
		const now = new Date();
		sqlQueue = [
			[{ id: AGENT, user_id: 'user-1' }], // ownership
			[{ id: DREAM, agent_id: AGENT, status: 'pending', kind: 'belief', statement: 'You prefer finality.', proposed_type: 'user', proposed_salience: 0.85, confidence: 0.8, source_memory_ids: [MEM], proposed_action: null }], // dream
			[{ id: MEM, type: 'user', content: 'You prefer finality.', salience: 0.85, created_at: now }], // memory insert
			[{ id: DREAM, agent_id: AGENT, status: 'accepted', kind: 'belief', statement: 'You prefer finality.', confidence: 0.8, source_memory_ids: [MEM], proposed_type: 'user', proposed_salience: 0.85, proposed_action: null, question: null, answer: null, accepted_memory_id: MEM, created_at: now, reviewed_at: now }], // reflection update
		];
		const req = mkReq({ method: 'POST', body: { agentId: AGENT, dreamId: DREAM, decision: 'accept' } });
		const res = mkRes();
		await dreamsHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.memory).toMatchObject({ id: MEM, type: 'user' });
		expect(body.memory.salience).toBe(0.85);
		expect(body.dream.status).toBe('accepted');
		// 4 sql calls: ownership, dream fetch, memory insert, reflection update.
		expect(sqlMock).toHaveBeenCalledTimes(4);
	});

	it('reject stores the rejection without writing a memory', async () => {
		const now = new Date();
		sqlQueue = [
			[{ id: AGENT, user_id: 'user-1' }], // ownership
			[{ id: DREAM, agent_id: AGENT, status: 'pending', kind: 'insight', statement: 'guess', proposed_type: 'project', proposed_salience: 0.7, confidence: 0.4, source_memory_ids: [MEM], proposed_action: null }], // dream
			[{ id: DREAM, agent_id: AGENT, status: 'rejected', kind: 'insight', statement: 'guess', confidence: 0.4, source_memory_ids: [MEM], proposed_type: 'project', proposed_salience: 0.7, proposed_action: null, question: null, answer: null, accepted_memory_id: null, created_at: now, reviewed_at: now }], // update
		];
		const req = mkReq({ method: 'POST', body: { agentId: AGENT, dreamId: DREAM, decision: 'reject' } });
		const res = mkRes();
		await dreamsHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.dream.status).toBe('rejected');
		expect(body.memory).toBeUndefined();
		// 3 sql calls: ownership, dream fetch, update (no memory insert).
		expect(sqlMock).toHaveBeenCalledTimes(3);
	});

	it('409s when the dream was already reviewed', async () => {
		sqlQueue = [
			[{ id: AGENT, user_id: 'user-1' }],
			[{ id: DREAM, agent_id: AGENT, status: 'accepted', statement: 'x' }],
		];
		const req = mkReq({ method: 'POST', body: { agentId: AGENT, dreamId: DREAM, decision: 'reject' } });
		const res = mkRes();
		await dreamsHandler(req, res);
		expect(res.statusCode).toBe(409);
	});

	it('rejects an invalid decision', async () => {
		const req = mkReq({ method: 'POST', body: { agentId: AGENT, dreamId: DREAM, decision: 'maybe' } });
		const res = mkRes();
		await dreamsHandler(req, res);
		expect(res.statusCode).toBe(400);
	});
});

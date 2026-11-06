/**
 * The Agent-wallet (api/mcp-agent.js) and x402 Bazaar (api/mcp-bazaar.js)
 * remotes must answer a plain, unauthenticated `tools/list` / `initialize`
 * (discovery-only batch) with 200 + the toolset — otherwise directory crawlers
 * and plain x402 agents that probe with a bare `tools/list` get a 402 and index
 * an empty server. This mirrors the discovery gate already covered for
 * /api/mcp-3d in mcp-3d-challenge.test.js. MCP protocol clients (Accept:
 * text/event-stream) must still receive the 401 that starts their OAuth flow.
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';
process.env.X402_PAY_TO_BASE ||= '0x0000000000000000000000000000000000000001';
process.env.X402_ASSET_ADDRESS_BASE ||= '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Bearer path is out of scope — no token is presented in these tests.
vi.mock('../../api/_lib/auth.js', () => ({
	extractBearer: () => null,
	authenticateBearer: vi.fn(async () => null),
}));

// No Upstash in unit tests — every limiter passes.
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: new Proxy(
		{},
		{ get: () => vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })) },
	),
	clientIp: vi.fn(() => '203.0.113.9'),
}));

// The bazaar client is a live network dependency; keep discovery hermetic.
vi.mock('../../api/_lib/x402/bazaar-client.js', async (orig) => {
	const actual = await orig();
	return { ...actual, searchBazaar: vi.fn(async () => ({ services: [] })) };
});

const { default: agentHandler } = await import('../../api/mcp-agent.js');
const { default: bazaarHandler } = await import('../../api/mcp-bazaar.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		end(body) {
			this.body = body ?? null;
		},
	};
}

function makeReq(url, { method = 'POST', headers = {}, body = null } = {}) {
	const payload = body == null ? '' : JSON.stringify(body);
	const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []);
	req.method = method;
	req.url = url;
	req.headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...headers };
	return req;
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const EVENT_STREAM = { accept: 'application/json, text/event-stream' };

const cases = [
	{ name: 'threews-agent (/api/mcp-agent)', url: '/api/mcp-agent', handler: () => agentHandler },
	{ name: 'threews-x402-bazaar (/api/mcp-bazaar)', url: '/api/mcp-bazaar', handler: () => bazaarHandler },
];

for (const c of cases) {
	describe(`${c.name} — free discovery for plain clients`, () => {
		it('answers a plain tools/list with 200 and a non-empty toolset', async () => {
			const res = makeRes();
			await c.handler()(makeReq(c.url, { body: TOOLS_LIST }), res);
			expect(res.statusCode).toBe(200);
			const out = JSON.parse(res.body);
			expect(out.error).toBeUndefined();
			expect(Array.isArray(out.result.tools)).toBe(true);
			expect(out.result.tools.length).toBeGreaterThan(0);
		});

		it('answers a plain initialize with 200', async () => {
			const res = makeRes();
			await c.handler()(makeReq(c.url, { body: INITIALIZE }), res);
			expect(res.statusCode).toBe(200);
			const out = JSON.parse(res.body);
			expect(out.result.serverInfo?.name).toBeTruthy();
		});

		it('still 401s an MCP protocol client on tools/list so OAuth can start', async () => {
			const res = makeRes();
			await c.handler()(makeReq(c.url, { body: TOOLS_LIST, headers: EVENT_STREAM }), res);
			expect(res.statusCode).toBe(401);
			expect(res.headers['www-authenticate']).toContain('oauth-protected-resource');
		});
	});
}

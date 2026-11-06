/**
 * POST /api/bnb/register-agent — integration tests.
 *
 * `../api/_lib/bnb/erc8004-gasless.js` and `../api/_lib/rate-limit.js` are
 * mocked so the suite runs deterministically without a live RPC/MegaFuel/
 * Redis — same pattern as tests/bnb-babt-check-endpoint.test.js. The relay's
 * own logic (parsing, sponsored/self-pay/declined decision, agentId
 * decoding) is covered directly in tests/bnb-erc8004-gasless.test.js; this
 * file only exercises the HTTP boundary: request validation, status/body
 * shaping, rate limiting, method/CORS. Synthetic addresses only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SENDER = '0xbCAa7f2ADB22146F8028fd4af0d0233cE3a60576'; // synthetic — no real key behind it
const SIGNED_TX = '0x' + 'f8'.repeat(40); // shape-only; the mock never parses it

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { bnbRegisterIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));

const relayState = { mode: 'sponsored' };
vi.mock('../api/_lib/bnb/erc8004-gasless.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/erc8004-gasless.js');
	return {
		...actual,
		relayGaslessRegistration: vi.fn(async ({ signedRegisterTx, network }) => {
			const net = network || 'bscTestnet';
			if (relayState.mode === 'alreadyRegistered') {
				return { alreadyRegistered: true, agentId: '42', address: SENDER, network: net };
			}
			if (relayState.mode === 'declined') {
				return { mode: 'declined', reason: 'no policy for sender', hint: 'fund and resign', address: SENDER, network: net };
			}
			if (relayState.mode === 'throws') {
				throw new actual.RegisterRelayError('transaction must call the ERC-8004 Identity Registry', { code: 'wrong_target', status: 400 });
			}
			// sponsored / self-pay — a real Registered-log-derived agentId
			return {
				mode: relayState.mode,
				hash: '0x' + 'a'.repeat(64),
				agentId: '7',
				pending: false,
				blockNumber: 123,
				address: SENDER,
				network: net,
			};
		}),
	};
});

const { default: handler } = await import('../api/bnb/register-agent.js');

function makeReq(body, { method = 'POST' } = {}) {
	return {
		method,
		url: '/api/bnb/register-agent',
		headers: { origin: 'https://three.ws', 'content-type': 'application/json' },
		socket: { remoteAddress: '127.0.0.1' },
		body,
	};
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function call(body, opts) {
	const req = makeReq(body, opts);
	const res = makeRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	rl.ok = true;
	relayState.mode = 'sponsored';
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('POST /api/bnb/register-agent — input validation', () => {
	it('400 when signedRegisterTx is missing', async () => {
		const r = await call({});
		expect(r._s).toBe(400);
		expect(r.json().error).toBe('bad_request');
	});
	it('400 when signedRegisterTx is not a string', async () => {
		const r = await call({ signedRegisterTx: 12345 });
		expect(r._s).toBe(400);
	});
});

describe('POST /api/bnb/register-agent — sponsored + self-pay success', () => {
	it('200 mode:sponsored — relays the signed tx and returns hash + agentId + explorerUrl', async () => {
		relayState.mode = 'sponsored';
		const r = await call({ signedRegisterTx: SIGNED_TX, network: 'bscTestnet' });
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.mode).toBe('sponsored');
		expect(body.hash).toBe('0x' + 'a'.repeat(64));
		expect(body.agentId).toBe('7');
		expect(body.explorerUrl).toContain(body.hash);
		expect(body.explorerUrl).toContain('testnet.bscscan.com');
	});

	it('200 mode:self-pay — same shape, different mode', async () => {
		relayState.mode = 'self-pay';
		const r = await call({ signedRegisterTx: SIGNED_TX });
		expect(r._s).toBe(200);
		expect(r.json().mode).toBe('self-pay');
	});
});

describe('POST /api/bnb/register-agent — declined + already-registered', () => {
	it('200 mode:declined with a hint, not an error', async () => {
		relayState.mode = 'declined';
		const r = await call({ signedRegisterTx: SIGNED_TX });
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.mode).toBe('declined');
		expect(body.hint).toBeTruthy();
	});

	it('200 alreadyRegistered — surfaces the existing agentId, address explorerUrl, no hash', async () => {
		relayState.mode = 'alreadyRegistered';
		const r = await call({ signedRegisterTx: SIGNED_TX });
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.alreadyRegistered).toBe(true);
		expect(body.agentId).toBe('42');
		expect(body.explorerUrl).toContain(SENDER);
	});
});

describe('POST /api/bnb/register-agent — relay error propagation', () => {
	it('maps a typed RegisterRelayError to its status + code', async () => {
		relayState.mode = 'throws';
		const r = await call({ signedRegisterTx: SIGNED_TX });
		expect(r._s).toBe(400);
		expect(r.json().error).toBe('wrong_target');
	});
});

describe('POST /api/bnb/register-agent — rate limiting', () => {
	it('429 when the IP bucket is exhausted', async () => {
		rl.ok = false;
		const r = await call({ signedRegisterTx: SIGNED_TX });
		expect(r._s).toBe(429);
	});
});

describe('POST /api/bnb/register-agent — method + CORS', () => {
	it('405 on GET', async () => {
		const r = await call(undefined, { method: 'GET' });
		expect(r._s).toBe(405);
	});
});

// /api/x402-pay?feed=1 — the public activity feed must degrade gracefully when
// Upstash Redis is unavailable (wrong credentials → WRONGPASS, outage, etc).
//
// Regression: a Redis LRANGE that throws used to escape readFeed() to the top of
// the handler and surface as an unhandled 500 (35× `UpstashError: WRONGPASS …
// command was: ["lrange",...]` in prod). The rate-limiter already degraded, but
// the feed read did not. The endpoint MUST return 200 with a (possibly empty,
// in-memory) feed when Redis is down — never 500.
//
// We mock getRedis() to return a client whose lrange rejects exactly the way a
// bad-password Upstash client does, and assert the GET still answers 200.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Auth/rate-limit/db are not exercised on the GET feed path, but the module
// imports them at load time — stub them so the import is side-effect free.
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => null,
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		x402PayIp: vi.fn(async () => ({ success: true })),
		x402PayGlobal: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));

const warnMock = vi.fn();
vi.mock('../../api/_lib/usage.js', () => ({
	logger: () => ({ info: vi.fn(), warn: warnMock, error: vi.fn() }),
	recordEvent: vi.fn(),
}));
vi.mock('../../api/_lib/db.js', () => ({ sql: vi.fn(async () => []), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// A Redis client that is present (so readFeed takes the Redis branch) but whose
// every command rejects the way a WRONGPASS-authenticated Upstash client does.
const lrangeMock = vi.fn(async () => {
	throw new Error('WRONGPASS invalid or missing auth token, command was: ["lrange","x402:pay:feed","0","49"]');
});
vi.mock('../../api/_lib/redis.js', () => ({
	getRedis: () => ({
		lrange: (...a) => lrangeMock(...a),
		lpush: async () => { throw new Error('WRONGPASS'); },
		ltrim: async () => { throw new Error('WRONGPASS'); },
		get: async () => { throw new Error('WRONGPASS'); },
		set: async () => { throw new Error('WRONGPASS'); },
	}),
}));

const { default: handler } = await import('../../api/x402-pay.js');

function makeGet(url) {
	return {
		url,
		method: 'GET',
		headers: { host: 'x' },
		query: {},
		on() { return this; },
	};
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(b) { this._body = b; },
	};
}
async function call(url) {
	const res = makeRes();
	await handler(makeGet(url), res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

beforeEach(() => {
	warnMock.mockReset();
	lrangeMock.mockClear();
});

describe('GET /api/x402-pay?feed=1 with Redis down', () => {
	it('returns 200 with a degraded (empty/stale) feed, never a 500', async () => {
		const { res, body } = await call('/api/x402-pay?feed=1');
		expect(res.statusCode).toBe(200);
		expect(body).toBeTruthy();
		expect(Array.isArray(body.items)).toBe(true);
		// The Redis read was attempted (and failed) — proving we exercised the
		// degraded path rather than skipping Redis entirely.
		expect(lrangeMock).toHaveBeenCalled();
		// The failure is logged as a warning, not thrown as an unhandled 500.
		expect(warnMock).toHaveBeenCalledWith('feed_read_failed', expect.any(Object));
	});

	it('honours the limit param while degraded', async () => {
		const { res, body } = await call('/api/x402-pay?feed=1&limit=5');
		expect(res.statusCode).toBe(200);
		expect(Array.isArray(body.items)).toBe(true);
		expect(body.items.length).toBeLessThanOrEqual(5);
	});
});

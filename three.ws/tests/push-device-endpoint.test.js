// /api/push/device: the iOS app's APNs token registry. The browser twin is
// /api/push/subscribe (tests/push-subscribe-endpoint.test.js). The rule most
// worth pinning is the refresh guard: the app re-sends its token on every
// launch without asking anyone, and that must never enrol the phone for a
// different account that happens to be signed in now.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const getRequestUserMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({ getRequestUser: (...a) => getRequestUserMock(...a) }));

const requireCsrfMock = vi.fn();
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: (...a) => requireCsrfMock(...a) }));

const pushSubscribeLimitMock = vi.fn();
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { pushSubscribe: (...a) => pushSubscribeLimitMock(...a) },
}));

const { default: handler } = await import('../api/push/device.js');

const USER = '28e98fb2-2a98-4500-b45a-5a9ad7b3f7a8';
// Capacitor reports tokens in upper case; the table stores lower case.
const TOKEN = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
const NEW_TOKEN = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

function mkReq({ method = 'POST', headers = {}, body = null } = {}) {
	const hdrs = { 'content-type': 'application/json', ...headers };
	return {
		method,
		url: '/api/push/device',
		headers: hdrs,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(() => cb());
			}
		},
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);
const queries = () => sqlMock.mock.calls.map(([strings]) => strings.join(' '));

beforeEach(() => {
	sqlMock.mockReset().mockResolvedValue([]);
	getRequestUserMock.mockReset().mockResolvedValue({ id: USER });
	requireCsrfMock.mockReset().mockResolvedValue(true);
	pushSubscribeLimitMock.mockReset().mockResolvedValue({ success: true, limit: 30, remaining: 29, reset: 0 });
});

describe('POST /api/push/device', () => {
	it('registers the device for the signed-in user, lower-casing the token', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { token: TOKEN, platform: 'ios', app_version: '1.0' } }), res);

		expect(res.statusCode).toBe(201);
		expect(parse(res)).toEqual({ ok: true });
		const [strings, ...values] = sqlMock.mock.calls[0];
		expect(strings.join(' ')).toContain('insert into apns_devices');
		// Latest owner wins, the same rule the Web Push table uses.
		expect(strings.join(' ')).toContain('on conflict (token) do update');
		expect(values).toEqual([USER, TOKEN.toLowerCase(), '1.0']);
	});

	it('rejects a token that is not hex before touching the database', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { token: 'not-a-token', platform: 'ios' } }), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a platform it does not deliver to', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { token: TOKEN, platform: 'android' } }), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('refuses an anonymous caller before CSRF, the limiter or the database', async () => {
		getRequestUserMock.mockResolvedValue(null);
		const res = mkRes();
		await handler(mkReq({ body: { token: TOKEN, platform: 'ios' } }), res);
		expect(res.statusCode).toBe(401);
		expect(requireCsrfMock).not.toHaveBeenCalled();
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('stops at the rate limiter', async () => {
		pushSubscribeLimitMock.mockResolvedValue({ success: false, limit: 30, remaining: 0, reset: Date.now() + 1000 });
		const res = mkRes();
		await handler(mkReq({ body: { token: TOKEN, platform: 'ios' } }), res);
		expect(res.statusCode).toBe(429);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/push/device refresh', () => {
	it('refuses to move a device to a different account that is signed in now', async () => {
		// The ownership lookup finds no row for this caller.
		sqlMock.mockResolvedValueOnce([]);
		const res = mkRes();
		await handler(mkReq({ body: { token: TOKEN, platform: 'ios', previous: TOKEN } }), res);

		expect(res.statusCode).toBe(409);
		expect(parse(res).error).toBe('not_owner');
		expect(queries().some((q) => q.includes('insert into apns_devices'))).toBe(false);
	});

	it('bumps the same token for its owner', async () => {
		sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]);
		const res = mkRes();
		await handler(mkReq({ body: { token: TOKEN, platform: 'ios', previous: TOKEN } }), res);

		expect(res.statusCode).toBe(201);
		expect(queries().some((q) => q.includes('delete from apns_devices'))).toBe(false);
		expect(queries().some((q) => q.includes('insert into apns_devices'))).toBe(true);
	});

	it('swaps a rotated token for its owner, dropping the old one', async () => {
		sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]);
		const res = mkRes();
		await handler(mkReq({ body: { token: NEW_TOKEN, platform: 'ios', previous: TOKEN } }), res);

		expect(res.statusCode).toBe(201);
		const del = sqlMock.mock.calls.find(([s]) => s.join(' ').includes('delete from apns_devices'));
		expect(del.slice(1)).toEqual([TOKEN.toLowerCase(), USER]);
		const ins = sqlMock.mock.calls.find(([s]) => s.join(' ').includes('insert into apns_devices'));
		expect(ins[2]).toBe(NEW_TOKEN);
	});
});

describe('DELETE /api/push/device', () => {
	it("removes only the caller's own row for that token", async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'DELETE', body: { token: TOKEN } }), res);

		expect(res.statusCode).toBe(200);
		const [strings, ...values] = sqlMock.mock.calls[0];
		expect(strings.join(' ')).toContain('delete from apns_devices');
		expect(values).toEqual([USER, TOKEN.toLowerCase()]);
	});
});

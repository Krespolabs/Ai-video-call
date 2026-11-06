import { describe, it, expect } from 'vitest';
import { embedReadCors } from '../api/_lib/http.js';

// The <agent-3d> embed runs on websites we have never heard of and reads two
// endpoints from there. Only the anonymous read may be opened to any origin.
function call(method, headers, options) {
	const sent = {};
	const res = { setHeader: (k, v) => { sent[k] = v; }, getHeader: (k) => sent[k], end() {}, statusCode: 200 };
	const ended = embedReadCors({ method, headers }, res, options);
	return { origin: sent['access-control-allow-origin'] ?? null, credentials: sent['access-control-allow-credentials'] ?? null, methods: sent['access-control-allow-methods'], ended };
}

describe('embedReadCors', () => {
	const stranger = 'https://bookshop.example';

	it('opens an anonymous GET to any origin, without credentials', () => {
		const got = call('GET', { origin: stranger });
		expect(got.origin).toBe('*');
		expect(got.credentials).toBeNull();
		expect(got.ended).toBe(false);
	});

	it('gives a stranger nothing once the request carries a cookie or a token', () => {
		expect(call('GET', { origin: stranger, cookie: 'sid=1' }).origin).toBeNull();
		expect(call('GET', { origin: stranger, authorization: 'Bearer x' }).origin).toBeNull();
	});

	it('refuses a stranger\'s preflight for a write, and for a read that wants to send a token', () => {
		const write = call('OPTIONS', { origin: stranger, 'access-control-request-method': 'PUT' }, { authedMethods: 'GET,PUT,DELETE,OPTIONS' });
		expect(write.origin).toBeNull();
		expect(write.ended).toBe(true);
		const authed = call('OPTIONS', { origin: stranger, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' });
		expect(authed.origin).toBeNull();
	});

	it('answers a plain GET preflight from a stranger', () => {
		const got = call('OPTIONS', { origin: stranger, 'access-control-request-method': 'GET' });
		expect(got.origin).toBe('*');
		expect(got.ended).toBe(true);
	});
});

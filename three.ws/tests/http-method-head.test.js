/**
 * http.js method() — HEAD handling.
 *
 * Regression guard for a production 504: a HEAD probe to an endpoint that allows
 * GET passed method()'s allowlist (HEAD is GET per RFC 9110 §9.3.2) but the
 * downstream handler dispatched on `req.method === 'GET'` (exact equality), so the
 * HEAD request fell through every branch, never responded, and hung until the
 * function's hard timeout. method() now normalizes an admitted HEAD to GET on the
 * request object so that equality dispatch runs. Safe because Node's ServerResponse
 * already captured the HEAD-ness at construction and strips the body regardless.
 */

import { describe, it, expect } from 'vitest';
import { method } from '../api/_lib/http.js';

function fakeRes() {
	const headers = {};
	return {
		statusCode: 0,
		body: undefined,
		ended: false,
		setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return headers[String(k).toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; },
		_headers: headers,
	};
}

describe('method() HEAD normalization', () => {
	it('admits a HEAD where GET is allowed and rewrites req.method to GET', () => {
		const req = { method: 'HEAD' };
		const res = fakeRes();
		expect(method(req, res, ['GET', 'PUT', 'PATCH', 'DELETE'])).toBe(true);
		// The load-bearing fix: downstream `if (req.method === 'GET')` must now run.
		expect(req.method).toBe('GET');
		expect(res.ended).toBe(false); // no 405 written
	});

	it('rejects HEAD where GET is not allowed, advertising the allowed methods', () => {
		const req = { method: 'HEAD' };
		const res = fakeRes();
		expect(method(req, res, ['POST'])).toBe(false);
		expect(req.method).toBe('HEAD'); // untouched — not normalized
		expect(res.statusCode).toBe(405);
		expect(res.getHeader('allow')).toBe('POST');
	});

	it('leaves a real GET untouched and advertises HEAD alongside it on rejection', () => {
		const req = { method: 'GET' };
		const res = fakeRes();
		expect(method(req, res, ['GET'])).toBe(true);
		expect(req.method).toBe('GET');

		const req2 = { method: 'DELETE' };
		const res2 = fakeRes();
		expect(method(req2, res2, ['GET'])).toBe(false);
		expect(res2.getHeader('allow')).toBe('GET, HEAD');
	});
});

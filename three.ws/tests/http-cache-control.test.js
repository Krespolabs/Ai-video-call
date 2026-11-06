/**
 * http.js Cache-Control boundary — unit tests.
 *
 * json()/text() are secure-by-default: they emit `no-store` UNLESS the handler
 * already set a Cache-Control header (the documented way a public read opts into
 * CDN caching) or passes one via the headers argument. Error responses must
 * NEVER inherit a permissive cache header, so error()/serverError()/
 * validationError() force `no-store`.
 *
 * Regression guard: previously json() unconditionally forced `no-store`, so a
 * handler that did `res.setHeader('cache-control', 'public, s-maxage=60')` right
 * before `json()` (e.g. /u/:username) was silently never cached.
 */

import { describe, it, expect } from 'vitest';
import { json, text, error, validationError } from '../api/_lib/http.js';

// Minimal ServerResponse stand-in: case-insensitive header store + end capture.
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

describe('json() cache-control', () => {
	it('defaults to no-store when nothing is set', () => {
		const res = fakeRes();
		json(res, 200, { ok: true });
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('respects a Cache-Control the handler set before calling json()', () => {
		const res = fakeRes();
		res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
		json(res, 200, { ok: true });
		expect(res.getHeader('cache-control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
	});

	it('respects a cache-control passed via the headers argument', () => {
		const res = fakeRes();
		json(res, 200, { ok: true }, { 'cache-control': 'public, s-maxage=120' });
		expect(res.getHeader('cache-control')).toBe('public, s-maxage=120');
	});

	it('still applies the security headers', () => {
		const res = fakeRes();
		json(res, 200, { ok: true });
		expect(res.getHeader('x-content-type-options')).toBe('nosniff');
		expect(res.getHeader('content-type')).toMatch(/application\/json/);
	});
});

describe('text() cache-control', () => {
	it('respects a pre-set Cache-Control', () => {
		const res = fakeRes();
		res.setHeader('cache-control', 'public, max-age=300');
		text(res, 200, 'hello');
		expect(res.getHeader('cache-control')).toBe('public, max-age=300');
	});
});

describe('error responses never cache', () => {
	it('error() forces no-store even when the success path set a permissive header', () => {
		const res = fakeRes();
		res.setHeader('cache-control', 'public, s-maxage=600');
		error(res, 404, 'not_found', 'nope');
		expect(res.getHeader('cache-control')).toBe('no-store');
		expect(res.statusCode).toBe(404);
	});

	it('validationError() forces no-store', () => {
		const res = fakeRes();
		res.setHeader('cache-control', 'public, s-maxage=600');
		validationError(res, { status: 400, code: 'validation_error', message: 'bad', issues: [] });
		expect(res.getHeader('cache-control')).toBe('no-store');
	});
});

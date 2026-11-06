// Unit tests for the rateLimited() / setRateLimitHeaders() helpers in
// api/_lib/http.js. These back the standardized 429 responses now emitted by
// 200+ endpoints, so the header + body contract is asserted directly here
// rather than per-endpoint.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rateLimited, setRateLimitHeaders } from '../../api/_lib/http.js';

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		ended: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = String(v);
		},
		end(payload) {
			this.ended = true;
			this.body = payload ? JSON.parse(payload) : null;
		},
	};
}

describe('setRateLimitHeaders', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-08T00:00:00Z'));
	});
	afterEach(() => vi.useRealTimers());

	it('advertises limit, remaining, and seconds-until-reset', () => {
		const res = mockRes();
		const sec = setRateLimitHeaders(res, {
			limit: 60,
			remaining: 12,
			reset: Date.now() + 30_000,
		});
		expect(sec).toBe(30);
		expect(res.headers['ratelimit-limit']).toBe('60');
		expect(res.headers['ratelimit-remaining']).toBe('12');
		expect(res.headers['ratelimit-reset']).toBe('30');
	});

	it('never reports negative remaining or reset', () => {
		const res = mockRes();
		const sec = setRateLimitHeaders(res, {
			limit: 10,
			remaining: -3,
			reset: Date.now() - 5_000,
		});
		expect(sec).toBe(0);
		expect(res.headers['ratelimit-remaining']).toBe('0');
		expect(res.headers['ratelimit-reset']).toBe('0');
	});

	it('rounds partial seconds up so clients never retry early', () => {
		const res = mockRes();
		setRateLimitHeaders(res, { reset: Date.now() + 1_200 });
		expect(res.headers['ratelimit-reset']).toBe('2');
	});

	it('tolerates a missing result', () => {
		const res = mockRes();
		expect(setRateLimitHeaders(res, undefined)).toBe(0);
		expect(res.headers['ratelimit-reset']).toBeUndefined();
	});
});

describe('rateLimited', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-08T00:00:00Z'));
	});
	afterEach(() => vi.useRealTimers());

	it('emits a 429 with Retry-After and the standard error envelope', () => {
		const res = mockRes();
		rateLimited(res, { limit: 60, remaining: 0, reset: Date.now() + 45_000 });
		expect(res.statusCode).toBe(429);
		expect(res.headers['retry-after']).toBe('45');
		expect(res.headers['ratelimit-limit']).toBe('60');
		expect(res.headers['ratelimit-remaining']).toBe('0');
		expect(res.body).toMatchObject({
			error: 'rate_limited',
			error_description: 'too many requests',
			retry_after: 45,
		});
	});

	it('clamps Retry-After to at least 1 second', () => {
		const res = mockRes();
		rateLimited(res, { reset: Date.now() }); // already expired
		expect(res.headers['retry-after']).toBe('1');
		expect(res.body.retry_after).toBe(1);
	});

	it('carries a custom message and merges extra body fields', () => {
		const res = mockRes();
		rateLimited(
			res,
			{ limit: 5, remaining: 0, reset: Date.now() + 10_000 },
			'slow down',
			{ scope: 'chat' },
		);
		expect(res.body.error_description).toBe('slow down');
		expect(res.body.scope).toBe('chat');
		expect(res.body.retry_after).toBe(10);
	});

	it('surfaces the limiter reason so clients can tell quota from a degraded limiter', () => {
		const res = mockRes();
		rateLimited(res, {
			limit: 30,
			remaining: 0,
			reset: Date.now() + 60_000,
			reason: 'rate_limiter_unavailable',
		});
		expect(res.body.reason).toBe('rate_limiter_unavailable');
	});

	it('omits reason when the limiter does not provide one', () => {
		const res = mockRes();
		rateLimited(res, { limit: 30, remaining: 0, reset: Date.now() + 60_000 });
		expect(res.body).not.toHaveProperty('reason');
	});
});

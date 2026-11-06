/**
 * CDN cache headers on the hot forge GET endpoints.
 *
 * ?catalog (every /forge load) and ?health (the status pill + uptime checks) are
 * the two highest-frequency reads on the forge surface. Under an influx they must
 * be served from the edge, not recomputed per request. These tests pin the
 * Cache-Control contract so the offload can't silently regress to no-store (the
 * http.js default).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
	process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-characters-long';
});

// The health probe does real network fan-out (backends, world.three.ws); stub it
// so this test stays hermetic and asserts only the cache contract.
vi.mock('../../api/_lib/forge-health.js', () => ({
	probeForgeHealth: vi.fn(async () => ({ status: 'ok', backends: {}, generated_at: 'now' })),
}));

const { default: handler } = await import('../../api/forge.js');

function makeReq(url) {
	return { method: 'GET', url, headers: { 'content-type': 'application/json' }, on() {} };
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		getHeader(name) {
			return this.headers[String(name).toLowerCase()];
		},
		end(body) {
			this.body = body ? JSON.parse(body) : null;
		},
	};
}

describe('forge hot-endpoint CDN caching', () => {
	it('serves ?catalog with a strong edge cache + stale-while-revalidate', async () => {
		const res = makeRes();
		await handler(makeReq('/api/forge?catalog=1'), res);

		expect(res.statusCode).toBe(200);
		const cc = res.headers['cache-control'] || '';
		expect(cc).toMatch(/public/);
		expect(cc).toMatch(/s-maxage=600/);
		expect(cc).toMatch(/stale-while-revalidate/);
		// It really returned the catalog (not an error shaped like one).
		expect(Array.isArray(res.body.backends)).toBe(true);
	});

	it('serves ?health with a short edge cache + stale-while-revalidate', async () => {
		const res = makeRes();
		await handler(makeReq('/api/forge?health=1'), res);

		expect(res.statusCode).toBe(200);
		const cc = res.headers['cache-control'] || '';
		expect(cc).toMatch(/public/);
		expect(cc).toMatch(/s-maxage=30/);
		expect(cc).toMatch(/stale-while-revalidate/);
		expect(res.body.status).toBe('ok');
	});
});

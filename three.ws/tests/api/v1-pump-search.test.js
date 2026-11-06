// GET /api/v1/pump/search — free text search over pump.fun / meme tokens.
//
// Registers the site's existing Birdeye-first/pump.fun-fallback search
// (api/_lib/pump-search.js `searchPumpTokens`, shared with the command
// palette's api/pump/search.js) under the versioned, cataloged /api/v1
// surface. These tests mock `searchPumpTokens` at the boundary — its own
// upstream fallback logic is covered by tests exercising api/pump/search.js's
// documented behavior — and exercise the real handler: a real-shaped hit,
// an honest empty miss (never 404/500), validation, the per-IP rate limit,
// and catalog registration.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

let quotaOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () => ({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }),
		publicIp: async () =>
			quotaOk
				? { success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }
				: { success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.11',
}));

let searchImpl = async () => [];
vi.mock('../../api/_lib/pump-search.js', () => ({
	searchPumpTokens: (q, limit) => searchImpl(q, limit),
}));

beforeEach(() => {
	quotaOk = true;
	searchImpl = async () => [];
});
afterEach(() => {
	vi.restoreAllMocks();
});

function makeReq({ url = '/api/v1/pump/search', host = 'three.ws' } = {}) {
	const stream = Readable.from([]);
	stream.method = 'GET';
	stream.url = url;
	stream.headers = { host };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function dispatch(req, res) {
	const mod = await import('../../api/v1/pump/search.js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('GET /api/v1/pump/search', () => {
	it('returns real-shaped hits for a query', async () => {
		searchImpl = async (q, limit) => {
			expect(q).toBe('three.ws');
			expect(limit).toBe(8);
			return [{ mint: THREE_MINT, symbol: 'three', name: 'three.ws', logo: null, price_usd: 0.0013, rank: null }];
		};
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/pump/search?q=three.ws' }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({
			results: [{ mint: THREE_MINT, symbol: 'three', name: 'three.ws', logo: null, price_usd: 0.0013, rank: null }],
			count: 1,
			q: 'three.ws',
		});
		expect(res.getHeader('cache-control')).toMatch(/max-age=15/);
	});

	it('an empty result is a valid 200, never a 404', async () => {
		searchImpl = async () => [];
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/pump/search?q=zzzznotfound' }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({ results: [], count: 0, q: 'zzzznotfound' });
	});

	it('requires q', async () => {
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/pump/search' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('clamps limit to 1..20, defaulting to 8', async () => {
		searchImpl = async (q, limit) => {
			expect(limit).toBe(20);
			return [];
		};
		await dispatch(makeReq({ url: '/api/v1/pump/search?q=sol&limit=999' }), makeRes());
	});

	it('returns 429 when the per-IP quota is exhausted', async () => {
		quotaOk = false;
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/pump/search?q=sol' }), makeRes());
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

describe('/api/v1 catalog', () => {
	it('registers the pump search endpoint as a free, public GET', async () => {
		const { CATALOG } = await import('../../api/v1/_catalog.js');
		const entry = CATALOG.find((e) => e.id === 'v1.pump.search');
		expect(entry).toBeTruthy();
		expect(entry.method).toBe('GET');
		expect(entry.path).toBe('/api/v1/pump/search');
		expect(entry.auth).toBe('public');
		expect(entry.params.q).toBeTruthy();
	});
});

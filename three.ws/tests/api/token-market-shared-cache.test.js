// Shared (L2) cache test for api/_lib/market/token-market.js.
//
// The scaling defense: Vercel runs many stateless lambda instances. The
// per-instance in-process cache (L1) is wiped on every cold start, so under a
// traffic spike each cold instance would independently fan out to all three
// upstreams. The shared cache (L2) lets a cold lambda serve a sibling's recent
// fetch instead, collapsing fleet-wide upstream load to ~1 call per key/window.
//
// We simulate a cold instance by clearing L1 only (__resetMarketCache) while the
// L2 store survives, and assert the second read hits zero upstreams. Fetch is
// fully mocked; no network. No Redis env here, so L2 resolves to cache.js's
// in-memory fallback — same code path, deterministic in tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let fetchCalls = [];
let fetchResponses = [];
vi.stubGlobal('fetch', (url) => {
	fetchCalls.push(String(url));
	const resp = fetchResponses.shift();
	if (!resp) throw new Error(`Unexpected fetch: ${url}`);
	return Promise.resolve({
		ok: resp.ok ?? true,
		status: resp.status ?? 200,
		json: async () => resp.body,
		text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)),
	});
});

import { fetchTokenMarketData, __resetMarketCache } from '../../api/_lib/market/token-market.js';

const MINT = 'THREEsynthetic222222222222222222222222222222';
const DEX_OK = {
	pairs: [
		{ priceUsd: '0.5', marketCap: 500000, liquidity: { usd: 100000 }, volume: { h24: 5000 }, priceChange: { h24: 1.5 } },
	],
};

beforeEach(() => {
	fetchCalls = [];
	fetchResponses = [];
	// No Birdeye key → DexScreener is the first source, so one upstream call.
	delete process.env.BIRDEYE_API_KEY;
	__resetMarketCache();
});

afterEach(() => {
	if (fetchResponses.length) {
		throw new Error(`Test left ${fetchResponses.length} unconsumed fetch mock(s)`);
	}
});

describe('token-market shared (L2) cache', () => {
	it('serves a cold instance (L1 cleared) from the shared cache with zero upstream calls', async () => {
		// Read 1: cold everywhere — one upstream fetch, populates L1 + L2.
		fetchResponses = [{ body: DEX_OK }];
		const first = await fetchTokenMarketData(MINT);
		expect(first.source).toBe('dexscreener');
		expect(first.price_usd).toBe(0.5);
		expect(fetchCalls).toHaveLength(1);

		// Simulate a NEW cold lambda: clear the in-process L1 only; L2 survives.
		__resetMarketCache();
		fetchCalls = [];
		fetchResponses = []; // any upstream call would throw "Unexpected fetch"

		const second = await fetchTokenMarketData(MINT);
		expect(second.price_usd).toBe(0.5);
		expect(fetchCalls).toHaveLength(0); // served entirely from the shared cache
	});

	it('still bypasses the shared cache when fresh:true is requested', async () => {
		fetchResponses = [{ body: DEX_OK }];
		await fetchTokenMarketData(MINT);

		// A forced-fresh read must hit upstream even though L2 holds a value.
		__resetMarketCache();
		fetchCalls = [];
		fetchResponses = [{ body: DEX_OK }];
		const fresh = await fetchTokenMarketData(MINT, { fresh: true });
		expect(fresh.source).toBe('dexscreener');
		expect(fetchCalls).toHaveLength(1);
	});
});

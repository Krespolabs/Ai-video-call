// Circuit-breaker tests for api/_lib/market/token-market.js.
//
// When a source reports an exhausted quota (Birdeye's "Compute units usage
// limit exceeded") or rate-limits us, the failover loop must stop calling it
// for the cooldown window instead of burning a doomed upstream request on
// every read. Fetch is fully mocked; no network.

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
import { cacheSet } from '../../api/_lib/cache.js';

const MINT = 'THREEsynthetic111111111111111111111111111111';

const QUOTA_BODY = '{"success":false,"message":"Compute units usage limit exceeded"}';
const DEX_OK = {
	pairs: [
		{ priceUsd: '0.5', marketCap: 500000, liquidity: { usd: 100000 }, volume: { h24: 5000 }, priceChange: { h24: 1.5 } },
	],
};

beforeEach(() => {
	fetchCalls = [];
	fetchResponses = [];
	process.env.BIRDEYE_API_KEY = 'test-key';
	__resetMarketCache();
});

afterEach(() => {
	delete process.env.BIRDEYE_API_KEY;
	if (fetchResponses.length) {
		throw new Error(`Test left ${fetchResponses.length} unconsumed fetch mock(s)`);
	}
});

describe('token-market source circuit breaker', () => {
	it('skips Birdeye on subsequent reads after a quota-exhausted error', async () => {
		// Read 1: Birdeye rejects with the quota error, DexScreener answers.
		fetchResponses = [
			{ ok: false, status: 400, body: QUOTA_BODY },
			{ body: DEX_OK },
		];
		const first = await fetchTokenMarketData(MINT, { fresh: true });
		expect(first.source).toBe('dexscreener');
		expect(fetchCalls.some((u) => u.includes('birdeye'))).toBe(true);

		// Read 2 (cache bypassed): Birdeye is under cooldown — the only upstream
		// call must be DexScreener.
		fetchCalls = [];
		fetchResponses = [{ body: DEX_OK }];
		const second = await fetchTokenMarketData(MINT, { fresh: true });
		expect(second.source).toBe('dexscreener');
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]).toContain('dexscreener');
	});

	it('keeps calling Birdeye after a non-quota failure (no false trips)', async () => {
		fetchResponses = [
			{ ok: false, status: 500, body: 'internal error' },
			{ body: DEX_OK },
		];
		await fetchTokenMarketData(MINT, { fresh: true });

		fetchCalls = [];
		fetchResponses = [
			{ ok: false, status: 500, body: 'internal error' },
			{ body: DEX_OK },
		];
		await fetchTokenMarketData(MINT, { fresh: true });
		expect(fetchCalls.some((u) => u.includes('birdeye'))).toBe(true);
	});

	it('inherits a fleet-mate cooldown from L2 (cold instance skips a dead source)', async () => {
		// Simulate a cold lambda: local breaker state is empty, but a sibling already
		// published an active Birdeye cooldown to the shared cache. The cold instance
		// must skip Birdeye without burning a doomed call against the exhausted quota.
		await cacheSet('mktcool:v1', { fromBirdeye: Date.now() + 6 * 3_600_000 }, 6 * 3600);

		fetchResponses = [{ body: DEX_OK }];
		const result = await fetchTokenMarketData(MINT, { fresh: true });
		expect(result.source).toBe('dexscreener');
		expect(fetchCalls.some((u) => u.includes('birdeye'))).toBe(false);
	});

	it('trips the breaker on a 429 rate limit as well', async () => {
		fetchResponses = [
			{ ok: false, status: 429, body: 'rate limited' },
			{ body: DEX_OK },
		];
		await fetchTokenMarketData(MINT, { fresh: true });

		fetchCalls = [];
		fetchResponses = [{ body: DEX_OK }];
		await fetchTokenMarketData(MINT, { fresh: true });
		expect(fetchCalls.some((u) => u.includes('birdeye'))).toBe(false);
	});
});

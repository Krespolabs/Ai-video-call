import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The cache (api/_lib/cache.js) must talk to a DEDICATED Upstash store when one is
// configured (UPSTASH_CACHE_REST_*), so its large best-effort writes never contend
// with — or burn the command quota of — the fail-closed rate limiter on
// UPSTASH_REDIS_REST_*. When no dedicated store is set it falls back to the shared
// store, and with neither it degrades to in-memory. These tests pin that routing by
// asserting which URL each command's fetch hits.
import { cacheGet, cacheSet, cacheBackend } from '../api/_lib/cache.js';

const DEDICATED = 'https://cache-store.upstash.io';
const SHARED = 'https://ratelimit-store.upstash.io';

const ENV_KEYS = [
	'UPSTASH_CACHE_REST_URL',
	'UPSTASH_CACHE_REST_TOKEN',
	'UPSTASH_REDIS_REST_URL',
	'UPSTASH_REDIS_REST_TOKEN',
	'cache_KV_REST_API_URL',
	'cache_KV_REST_API_TOKEN',
];

let saved;

// Mock fetch to record the target URL and return a well-formed Upstash REST reply.
// `SET` → result 'OK'; `GET` → the stored JSON string (here, a miss → null).
function installFetch(record) {
	globalThis.fetch = vi.fn(async (url, opts) => {
		record.url = url;
		const [cmd] = JSON.parse(opts.body);
		const result = cmd === 'SET' ? 'OK' : null;
		return { ok: true, json: async () => ({ result }) };
	});
}

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.restoreAllMocks();
});

describe('cache store routing', () => {
	it('routes to the dedicated cache store when UPSTASH_CACHE_REST_* is set', async () => {
		process.env.UPSTASH_CACHE_REST_URL = DEDICATED;
		process.env.UPSTASH_CACHE_REST_TOKEN = 'cache-token';
		process.env.UPSTASH_REDIS_REST_URL = SHARED;
		process.env.UPSTASH_REDIS_REST_TOKEN = 'shared-token';
		const record = {};
		installFetch(record);

		await cacheSet('routing:dedicated', { v: 1 }, 30);

		expect(record.url).toBe(DEDICATED);
		expect(cacheBackend()).toBe('upstash');
	});

	it('accepts the Vercel-KV second-store name (cache_KV_REST_API_*)', async () => {
		process.env.cache_KV_REST_API_URL = DEDICATED;
		process.env.cache_KV_REST_API_TOKEN = 'cache-token';
		process.env.UPSTASH_REDIS_REST_URL = SHARED;
		process.env.UPSTASH_REDIS_REST_TOKEN = 'shared-token';
		const record = {};
		installFetch(record);

		await cacheSet('routing:kv-name', { v: 2 }, 30);

		expect(record.url).toBe(DEDICATED);
	});

	it('falls back to the shared rate-limiter store when no dedicated store is set', async () => {
		process.env.UPSTASH_REDIS_REST_URL = SHARED;
		process.env.UPSTASH_REDIS_REST_TOKEN = 'shared-token';
		const record = {};
		installFetch(record);

		await cacheGet('routing:shared');

		expect(record.url).toBe(SHARED);
		expect(cacheBackend()).toBe('upstash');
	});

	it('degrades to in-memory (no fetch) when neither store is configured', async () => {
		const record = {};
		installFetch(record);

		await cacheSet('routing:mem', { v: 3 }, 30);
		const back = await cacheGet('routing:mem');

		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(record.url).toBeUndefined();
		expect(back).toEqual({ v: 3 });
		expect(cacheBackend()).toBe('memory');
	});
});

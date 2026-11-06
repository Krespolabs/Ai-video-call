/**
 * env.js Upstash credential hygiene — unit test.
 *
 * A trailing newline or stray space on UPSTASH_REDIS_REST_TOKEN (the classic
 * Vercel/Upstash dashboard paste artifact) lands verbatim in the
 * `Authorization: Bearer <token>` header the @upstash/redis client sends, which
 * Upstash rejects as "WRONGPASS invalid or missing auth token" — while the URL
 * still resolves, so every limiter fails closed and the usage buffer + caches go
 * silently dark. The getters trim at the source so no consumer ever sees the
 * whitespace. This pins that, plus the whitespace-only-primary fall-through to the
 * Vercel-KV marketplace aliases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from '../api/_lib/env.js';

const KEYS = [
	'UPSTASH_REDIS_REST_URL',
	'UPSTASH_REDIS_REST_TOKEN',
	'three_KV_REST_API_URL',
	'three_KV_REST_API_TOKEN',
	'KV_REST_API_URL',
	'KV_REST_API_TOKEN',
	'UPSTASH_CACHE_REST_URL',
	'UPSTASH_CACHE_REST_TOKEN',
	'cache_KV_REST_API_URL',
	'cache_KV_REST_API_TOKEN',
];
let saved;

beforeEach(() => {
	saved = {};
	for (const k of KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('env Upstash credential trimming', () => {
	it('strips a trailing newline from the REST token (the WRONGPASS cause)', () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'AX1ssecret-token\n';
		expect(env.UPSTASH_REDIS_REST_TOKEN).toBe('AX1ssecret-token');
	});

	it('strips surrounding whitespace from the REST url', () => {
		process.env.UPSTASH_REDIS_REST_URL = '  https://example.upstash.io \n';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
		expect(env.UPSTASH_REDIS_REST_URL).toBe('https://example.upstash.io');
	});

	it('returns undefined for a blank/whitespace-only value', () => {
		process.env.UPSTASH_REDIS_REST_TOKEN = '   \n';
		expect(env.UPSTASH_REDIS_REST_TOKEN).toBeUndefined();
	});

	it('falls through to the Vercel-KV alias pair when the primary pair is incomplete', () => {
		// Primary source has a whitespace-only token (→ incomplete pair); the KV
		// marketplace alias supplies a complete url+token pair and wins.
		process.env.UPSTASH_REDIS_REST_TOKEN = '   ';
		process.env.KV_REST_API_URL = 'https://alias.upstash.io';
		process.env.KV_REST_API_TOKEN = 'alias-token\n';
		expect(env.UPSTASH_REDIS_REST_URL).toBe('https://alias.upstash.io');
		expect(env.UPSTASH_REDIS_REST_TOKEN).toBe('alias-token');
	});

	it('trims the dedicated cache store credentials and their aliases', () => {
		process.env.UPSTASH_CACHE_REST_URL = ' ';
		process.env.cache_KV_REST_API_URL = 'https://cache.upstash.io\n';
		process.env.cache_KV_REST_API_TOKEN = '  cache-tok  ';
		expect(env.UPSTASH_CACHE_REST_URL).toBe('https://cache.upstash.io');
		expect(env.UPSTASH_CACHE_REST_TOKEN).toBe('cache-tok');
	});

	it('leaves a clean url+token pair untouched', () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'AX1sclean';
		expect(env.UPSTASH_REDIS_REST_URL).toBe('https://example.upstash.io');
		expect(env.UPSTASH_REDIS_REST_TOKEN).toBe('AX1sclean');
	});
});

describe('env CACHE_REDIS_CMD_TIMEOUT_MS (cache command timeout knob)', () => {
	const saveTimeout = () => process.env.CACHE_REDIS_CMD_TIMEOUT_MS;
	let savedTimeout;
	beforeEach(() => {
		savedTimeout = saveTimeout();
		delete process.env.CACHE_REDIS_CMD_TIMEOUT_MS;
	});
	afterEach(() => {
		if (savedTimeout === undefined) delete process.env.CACHE_REDIS_CMD_TIMEOUT_MS;
		else process.env.CACHE_REDIS_CMD_TIMEOUT_MS = savedTimeout;
	});

	it('defaults to 3000ms when unset', () => {
		expect(env.CACHE_REDIS_CMD_TIMEOUT_MS).toBe(3000);
	});

	it('honors a valid override (region-latency headroom)', () => {
		process.env.CACHE_REDIS_CMD_TIMEOUT_MS = '8000';
		expect(env.CACHE_REDIS_CMD_TIMEOUT_MS).toBe(8000);
	});

	it('clamps to the [500, 30000] band and rounds', () => {
		process.env.CACHE_REDIS_CMD_TIMEOUT_MS = '100';
		expect(env.CACHE_REDIS_CMD_TIMEOUT_MS).toBe(500);
		process.env.CACHE_REDIS_CMD_TIMEOUT_MS = '999999';
		expect(env.CACHE_REDIS_CMD_TIMEOUT_MS).toBe(30000);
		process.env.CACHE_REDIS_CMD_TIMEOUT_MS = '4500.7';
		expect(env.CACHE_REDIS_CMD_TIMEOUT_MS).toBe(4501);
	});

	it('falls back to the default for an unparseable value', () => {
		process.env.CACHE_REDIS_CMD_TIMEOUT_MS = 'not-a-number';
		expect(env.CACHE_REDIS_CMD_TIMEOUT_MS).toBe(3000);
	});

	it('falls back to the default for a blank value (must NOT clamp 0 → 500ms)', () => {
		// A dashboard key left empty (`CACHE_REDIS_CMD_TIMEOUT_MS=`) must not become
		// Number('')===0 clamped up to the 500ms floor — that would make timeouts
		// worse, the opposite of the knob's intent.
		process.env.CACHE_REDIS_CMD_TIMEOUT_MS = '';
		expect(env.CACHE_REDIS_CMD_TIMEOUT_MS).toBe(3000);
		process.env.CACHE_REDIS_CMD_TIMEOUT_MS = '   ';
		expect(env.CACHE_REDIS_CMD_TIMEOUT_MS).toBe(3000);
	});
});

describe('env Upstash atomic credential pairing (cross-store WRONGPASS guard)', () => {
	it('never pairs a URL from one source with a token from another', () => {
		// The exact prod failure: a manual URL (store A) + an integration-injected
		// token (store B). Independent `||` chains would emit url-A + token-B, which
		// Upstash rejects as WRONGPASS. Atomic pairing must reject the incomplete
		// primary and fall to the only fully-configured source instead.
		process.env.UPSTASH_REDIS_REST_URL = 'https://store-a.upstash.io';
		process.env.KV_REST_API_TOKEN = 'store-b-token';
		// Primary pair: url set, token missing → incomplete. KV pair: token set, url
		// missing → incomplete. No complete source → both halves undefined (so
		// getRedis() skips cleanly instead of authenticating as WRONGPASS).
		expect(env.UPSTASH_REDIS_REST_URL).toBeUndefined();
		expect(env.UPSTASH_REDIS_REST_TOKEN).toBeUndefined();
	});

	it('returns a matched pair from the same source when one is complete', () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://store-a.upstash.io';
		process.env.three_KV_REST_API_URL = 'https://store-b.upstash.io';
		process.env.three_KV_REST_API_TOKEN = 'store-b-token';
		// Primary pair incomplete (no token); the `three_` source is complete and
		// its URL and token travel together.
		expect(env.UPSTASH_REDIS_REST_URL).toBe('https://store-b.upstash.io');
		expect(env.UPSTASH_REDIS_REST_TOKEN).toBe('store-b-token');
	});

	it('prefers the highest-priority complete source', () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://primary.upstash.io';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'primary-token';
		process.env.KV_REST_API_URL = 'https://alias.upstash.io';
		process.env.KV_REST_API_TOKEN = 'alias-token';
		expect(env.UPSTASH_REDIS_REST_URL).toBe('https://primary.upstash.io');
		expect(env.UPSTASH_REDIS_REST_TOKEN).toBe('primary-token');
	});
});

/**
 * cache.js wire compression — unit test.
 *
 * Large best-effort cache bodies (the galaxy money-feed, trending snapshots) are
 * highly compressible JSON. Shipping them raw over Upstash REST from a region not
 * co-located with the function is the root cause of the "operation aborted due to
 * timeout" SET failures: the body can't finish inside the command deadline. The
 * cache now gzips anything over COMPRESS_MIN_BYTES before the wire, gates the size
 * guard on the COMPRESSED bytes, and transparently decompresses on read — while
 * legacy plaintext values still parse. This pins that behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';

const SHARED = 'https://cache-store.upstash.io';
const ENV_KEYS = ['UPSTASH_CACHE_REST_URL', 'UPSTASH_CACHE_REST_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
let saved;

// Minimal in-memory Upstash stand-in: SET stores the raw wire body, GET returns
// it verbatim — exactly what a real store round-trips, so the codec is exercised
// end to end rather than mocked away.
function fakeUpstash() {
	const store = new Map();
	const calls = [];
	const fetchMock = vi.fn(async (_url, init) => {
		const args = JSON.parse(init.body);
		calls.push(args);
		const [cmd, key, val] = args;
		if (cmd === 'SET') { store.set(key, val); return { ok: true, json: async () => ({ result: 'OK' }) }; }
		if (cmd === 'GET') { return { ok: true, json: async () => ({ result: store.has(key) ? store.get(key) : null }) }; }
		if (cmd === 'DEL') { store.delete(key); return { ok: true, json: async () => ({ result: 1 }) }; }
		return { ok: true, json: async () => ({ result: null }) };
	});
	return { store, calls, fetchMock };
}

function incompressible(len) {
	let out = '';
	let x = 0x9e3779b1;
	while (out.length < len) {
		x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
		out += String.fromCharCode(33 + (x % 94));
	}
	return out;
}

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
	process.env.UPSTASH_CACHE_REST_URL = SHARED;
	process.env.UPSTASH_CACHE_REST_TOKEN = 'cache-token';
	vi.resetModules();
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.restoreAllMocks();
});

describe('cache wire compression', () => {
	it('compresses a large compressible value and round-trips it through Redis', async () => {
		const { store, calls, fetchMock } = fakeUpstash();
		globalThis.fetch = fetchMock;
		const { cacheSet, cacheGetFresh } = await import('../api/_lib/cache.js');

		// ~200KB of repetitive JSON — highly compressible, well over COMPRESS_MIN_BYTES.
		const value = { rows: Array.from({ length: 4000 }, (_, i) => ({ id: i, label: 'flow-node', amount: 1000 })) };
		const rawBytes = JSON.stringify(value).length;

		await cacheSet('cmp:big', value, 30);

		// It reached the network (was NOT shunted to memory-only) and the stored
		// body is the compressed sentinel form, far smaller than the raw JSON.
		const setArgs = calls.find((c) => c[0] === 'SET' && c[1] === 'cmp:big');
		expect(setArgs).toBeTruthy();
		const stored = setArgs[2];
		expect(stored.startsWith('\u0000gz:')).toBe(true);
		expect(stored.length).toBeLessThan(rawBytes / 2);
		expect(store.get('cmp:big')).toBe(stored);

		// A fresh GET (memo bypassed) decompresses back to the exact original.
		const got = await cacheGetFresh('cmp:big');
		expect(got).toEqual(value);
	});

	it('stores small values as raw JSON — no compression framing', async () => {
		const { calls, fetchMock } = fakeUpstash();
		globalThis.fetch = fetchMock;
		const { cacheSet, cacheGetFresh } = await import('../api/_lib/cache.js');

		await cacheSet('cmp:small', { v: 1, name: 'ok' }, 30);
		const setArgs = calls.find((c) => c[0] === 'SET' && c[1] === 'cmp:small');
		expect(setArgs[2]).toBe(JSON.stringify({ v: 1, name: 'ok' })); // stored verbatim
		expect(await cacheGetFresh('cmp:small')).toEqual({ v: 1, name: 'ok' });
	});

	it('reads legacy plaintext values written before compression existed', async () => {
		const { store, fetchMock } = fakeUpstash();
		globalThis.fetch = fetchMock;
		const { cacheGetFresh } = await import('../api/_lib/cache.js');

		// Simulate a value written by the previous format: raw JSON, no sentinel.
		store.set('legacy:key', JSON.stringify({ legacy: true, n: 42 }));
		expect(await cacheGetFresh('legacy:key')).toEqual({ legacy: true, n: 42 });
	});

	it('reads a compressed value produced out-of-band (decode path is stable)', async () => {
		const { store, fetchMock } = fakeUpstash();
		globalThis.fetch = fetchMock;
		const { cacheGetFresh } = await import('../api/_lib/cache.js');

		const value = { hello: 'world', list: [1, 2, 3] };
		const wire = '\u0000gz:' + gzipSync(JSON.stringify(value)).toString('base64');
		store.set('oob:key', wire);
		expect(await cacheGetFresh('oob:key')).toEqual(value);
	});

	it('leaves an incompressible value on the raw path when gzip would not shrink it', async () => {
		const { calls, fetchMock } = fakeUpstash();
		globalThis.fetch = fetchMock;
		const { cacheSet, cacheGetFresh } = await import('../api/_lib/cache.js');

		// High-entropy but under the size cap: encodeForWire's only-if-smaller guard
		// must fall back to raw JSON rather than ship a larger base64(gzip) body.
		const value = { blob: incompressible(2_000) };
		await cacheSet('cmp:noise', value, 30);
		const setArgs = calls.find((c) => c[0] === 'SET' && c[1] === 'cmp:noise');
		expect(setArgs[2].startsWith('\u0000gz:')).toBe(false); // stayed raw
		expect(await cacheGetFresh('cmp:noise')).toEqual(value);
	});
});

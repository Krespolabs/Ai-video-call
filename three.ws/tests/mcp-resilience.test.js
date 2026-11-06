import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
	resilientFetch,
	fetchJson,
	parseRetryAfterMs,
	backoffMs,
} from '../mcp-server/src/lib/resilient-fetch.js';
import {
	getSolanaEndpoints,
	withSolanaConnection,
	_resetSolanaCache,
} from '../mcp-server/src/lib/solana-rpc.js';
import { getEvmRpcUrls } from '../mcp-server/src/lib/evm-rpc.js';

// A Response stub good enough for resilientFetch (status, ok, headers.get,
// arrayBuffer drain, json/text bodies).
function res(status, body = {}, headers = {}) {
	const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
		arrayBuffer: async () => new ArrayBuffer(0),
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

describe('resilientFetch — timeout + safe retries', () => {
	let fetchMock;
	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('returns the first 2xx without retrying', async () => {
		fetchMock.mockResolvedValueOnce(res(200, { ok: true }));
		const r = await resilientFetch('https://x.test', {}, { retries: 3 });
		expect(r.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('retries a GET on a 503 then succeeds', async () => {
		fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, { ok: true }));
		const r = await resilientFetch(
			'https://x.test',
			{},
			{ retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
		);
		expect(r.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('retries a GET on a network error then succeeds', async () => {
		fetchMock
			.mockRejectedValueOnce(new Error('ECONNRESET'))
			.mockResolvedValueOnce(res(200, { ok: true }));
		const r = await resilientFetch(
			'https://x.test',
			{},
			{ retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
		);
		expect(r.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('does NOT retry a non-idempotent POST by default (no double-send)', async () => {
		fetchMock.mockResolvedValueOnce(res(503));
		const r = await resilientFetch(
			'https://x.test',
			{ method: 'POST' },
			{ retries: 3, baseDelayMs: 1 },
		);
		expect(r.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('retries a POST when the caller opts in with retryNonIdempotent', async () => {
		fetchMock.mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200, { ok: true }));
		const r = await resilientFetch(
			'https://x.test',
			{ method: 'POST' },
			{ retries: 2, retryNonIdempotent: true, baseDelayMs: 1, maxDelayMs: 2 },
		);
		expect(r.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('returns the last response (not throw) when retries are exhausted on status', async () => {
		fetchMock.mockResolvedValue(res(429));
		const r = await resilientFetch(
			'https://x.test',
			{},
			{ retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
		);
		expect(r.status).toBe(429);
		expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
	});

	it('times out a hung request and surfaces a TimeoutError', async () => {
		// fetch never resolves until aborted; reject when the signal fires.
		fetchMock.mockImplementation(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener('abort', () =>
						reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
					);
				}),
		);
		await expect(
			resilientFetch('https://x.test', {}, { timeoutMs: 10, retries: 0 }),
		).rejects.toThrow(/timed out/i);
	});

	it('fetchJson throws on a non-2xx final response', async () => {
		fetchMock.mockResolvedValue(res(404, { error: 'nope' }));
		await expect(fetchJson('https://x.test', {}, { retries: 0 })).rejects.toThrow(/HTTP 404/);
	});

	it('fetchJson returns parsed JSON on success', async () => {
		fetchMock.mockResolvedValueOnce(res(200, { hello: 'world' }));
		await expect(fetchJson('https://x.test', {}, { retries: 0 })).resolves.toEqual({
			hello: 'world',
		});
	});
});

describe('parseRetryAfterMs', () => {
	it('parses delta-seconds', () => {
		expect(parseRetryAfterMs(res(429, {}, { 'retry-after': '2' }))).toBe(2000);
	});
	it('returns null when absent', () => {
		expect(parseRetryAfterMs(res(429))).toBeNull();
	});
});

describe('backoffMs — full jitter within the doubling cap', () => {
	it('never exceeds the cap and grows the cap each attempt', () => {
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const cap = Math.min(4000, 250 * 2 ** attempt);
			for (let i = 0; i < 50; i += 1) {
				const d = backoffMs(attempt, 250, 4000);
				expect(d).toBeGreaterThanOrEqual(0);
				expect(d).toBeLessThanOrEqual(cap);
			}
		}
	});
});

describe('getSolanaEndpoints — env-driven failover list', () => {
	const saved = { list: process.env.SOLANA_RPC_URLS, single: process.env.SOLANA_RPC_URL };
	afterEach(() => {
		process.env.SOLANA_RPC_URLS = saved.list;
		process.env.SOLANA_RPC_URL = saved.single;
		delete process.env.SOLANA_RPC_URLS;
		delete process.env.SOLANA_RPC_URL;
	});

	it('always returns at least the built-in defaults', () => {
		delete process.env.SOLANA_RPC_URLS;
		delete process.env.SOLANA_RPC_URL;
		const eps = getSolanaEndpoints();
		expect(eps.length).toBeGreaterThanOrEqual(1);
		expect(eps).toContain('https://api.mainnet-beta.solana.com');
	});

	it('puts the comma list first, then the single primary, deduped', () => {
		process.env.SOLANA_RPC_URLS = 'https://a.test, https://b.test';
		process.env.SOLANA_RPC_URL = 'https://b.test'; // duplicate of list entry
		const eps = getSolanaEndpoints();
		expect(eps[0]).toBe('https://a.test');
		expect(eps[1]).toBe('https://b.test');
		expect(eps.filter((e) => e === 'https://b.test')).toHaveLength(1);
	});
});

describe('withSolanaConnection — endpoint failover', () => {
	beforeEach(() => {
		process.env.SOLANA_RPC_URLS = 'https://a.test,https://b.test,https://c.test';
		_resetSolanaCache();
	});
	afterEach(() => {
		delete process.env.SOLANA_RPC_URLS;
		_resetSolanaCache();
	});

	it('falls over to the next endpoint when one fails and returns the success', async () => {
		let calls = 0;
		const out = await withSolanaConnection(async (conn) => {
			calls += 1;
			// First endpoint throws, second succeeds. Use the connection identity
			// to vary behavior across the failover loop.
			if (calls === 1) throw new Error('rpc down');
			return { endpoint: conn.rpcEndpoint, calls };
		});
		expect(out.calls).toBe(2);
	});

	it('throws the last error only when every endpoint fails', async () => {
		await expect(
			withSolanaConnection(async () => {
				throw new Error('all dead');
			}),
		).rejects.toThrow(/all dead/);
	});
});

describe('getEvmRpcUrls — per-chain redundancy + overrides', () => {
	it('returns multiple built-in endpoints for a known chain', () => {
		const urls = getEvmRpcUrls(8453);
		expect(urls.length).toBeGreaterThanOrEqual(2);
	});

	it('puts caller overrides first and dedupes', () => {
		const urls = getEvmRpcUrls(1, ['https://my.rpc', 'https://eth.llamarpc.com']);
		expect(urls[0]).toBe('https://my.rpc');
		expect(urls.filter((u) => u === 'https://eth.llamarpc.com')).toHaveLength(1);
	});

	it('throws for an unknown chain with no endpoints', () => {
		expect(() => getEvmRpcUrls(999999)).toThrow(/no endpoints/);
	});
});

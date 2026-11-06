// api/_lib/market-data.js — DeFiLlama market-data layer.
//
// No live network: fetch is mocked with vi.stubGlobal so these exercise the
// module's real caching, backoff, filtering, and shape-mapping logic against
// controlled payloads (allowed under the no-mocks rule — that bars fake data
// in the product, not test doubles). Live-network verification is captured
// separately (see the task report) with a real `node -e` invocation.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	getProtocols,
	getProtocol,
	getYieldPools,
	getChainTvls,
	getDexVolumes,
	getFearGreed,
	fetchWithRetry,
	clearMarketDataCache,
	CACHE_TTL,
} from '../api/_lib/market-data.js';

function jsonResponse(status, body) {
	return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body };
}

let fetchMock;

beforeEach(() => {
	clearMarketDataCache();
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const PROTOCOLS_FIXTURE = [
	{ slug: 'aave', name: 'Aave', tvl: 20_000_000_000, category: 'Lending', chain: 'Ethereum', chains: ['Ethereum', 'Arbitrum'], change_1d: 1.2, change_7d: -3.4, logo: 'https://x/aave.png' },
	{ slug: 'lido', name: 'Lido', tvl: 30_000_000_000, category: 'Liquid Staking', chain: 'Ethereum', chains: ['Ethereum'], change_1d: 0.5, change_7d: 2.1, logo: 'https://x/lido.png' },
	{ slug: 'gmx', name: 'GMX', tvl: 500_000_000, category: 'Derivatives', chain: 'Arbitrum', chains: ['Arbitrum'], change_1d: -0.8, change_7d: 5.6, logo: '' },
];

const CHAINS_FIXTURE = [
	{ name: 'Ethereum', tvl: 60_000_000_000, tokenSymbol: 'ETH', change_1d: 1.1 },
	{ name: 'Arbitrum', tvl: 20_000_000_000, tokenSymbol: 'ARB', change_1d: -0.4 },
	{ name: 'Solana', tvl: 20_000_000_000, tokenSymbol: 'SOL', change_1d: 3.3 },
];

const DEX_FIXTURE = {
	protocols: [
		{ name: 'Uniswap', total24h: 2_000_000_000, change_1d: 4.2, chains: ['Ethereum', 'Arbitrum'] },
		{ name: 'Raydium', total24h: 800_000_000, change_1d: -1.1, chains: ['Solana'] },
	],
};

const YIELDS_FIXTURE = {
	data: [
		{ pool: 'p1', project: 'aave-v3', chain: 'Arbitrum', symbol: 'USDC', tvlUsd: 50_000_000, apy: 8.2, apyBase: 3.1, apyReward: 5.1, stablecoin: true, ilRisk: 'no' },
		{ pool: 'p2', project: 'lido', chain: 'Ethereum', symbol: 'STETH', tvlUsd: 900_000_000, apy: 3.5, apyBase: 3.5, apyReward: 0, stablecoin: false, ilRisk: 'no' },
		{ pool: 'p3', project: 'aave-v3', chain: 'Arbitrum', symbol: 'ETH', tvlUsd: 40_000_000, apy: 2.1, apyBase: 2.1, apyReward: 0, stablecoin: false, ilRisk: 'no' },
		{ pool: 'p4', project: 'gmx', chain: 'Arbitrum', symbol: 'USDC-ARB', tvlUsd: 10_000_000, apy: 15.4, apyBase: 4.0, apyReward: 11.4, stablecoin: true, ilRisk: 'yes' },
	],
};

const FNG_FIXTURE = {
	data: [{ value: '72', value_classification: 'Greed', timestamp: '1783670400' }],
};

describe('fetchWithRetry', () => {
	it('returns parsed JSON on a clean 200', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		await expect(fetchWithRetry('https://x/ok')).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('retries with backoff on 429 then succeeds', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(429, {}))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

		const promise = fetchWithRetry('https://x/rl');
		await vi.advanceTimersByTimeAsync(2100);
		await expect(promise).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('retries on 5xx then succeeds', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(503, {}))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

		const promise = fetchWithRetry('https://x/5xx');
		await vi.advanceTimersByTimeAsync(2100);
		await expect(promise).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('propagates the error after exhausting retries', async () => {
		fetchMock.mockResolvedValue(jsonResponse(500, {}));

		const promise = fetchWithRetry('https://x/down', { maxRetries: 2 });
		// Suppress an unhandled-rejection warning racing the timer advance below —
		// the assertion still observes the real rejection via expect().rejects.
		promise.catch(() => {});
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(promise).rejects.toThrow(/HTTP 500/);
		expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
	});

	it('does not retry a non-retryable 4xx', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));
		await expect(fetchWithRetry('https://x/missing')).rejects.toThrow(/HTTP 404/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('propagates a network error after retries', async () => {
		fetchMock.mockRejectedValue(new Error('ECONNRESET'));
		const promise = fetchWithRetry('https://x/reset', { maxRetries: 1 });
		promise.catch(() => {});
		await vi.advanceTimersByTimeAsync(5000);
		await expect(promise).rejects.toThrow(/ECONNRESET/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('getProtocols', () => {
	it('sorts by TVL desc, slices to limit, and maps fields', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, PROTOCOLS_FIXTURE));
		const result = await getProtocols({ limit: 2 });
		expect(result).toEqual([
			{ slug: 'lido', name: 'Lido', tvl: 30_000_000_000, category: 'Liquid Staking', chain: 'Ethereum', change1d: 0.5, change7d: 2.1, logo: 'https://x/lido.png' },
			{ slug: 'aave', name: 'Aave', tvl: 20_000_000_000, category: 'Lending', chain: 'Ethereum', change1d: 1.2, change7d: -3.4, logo: 'https://x/aave.png' },
		]);
	});

	it('filters by chain (matches chain or chains[])', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, PROTOCOLS_FIXTURE));
		const result = await getProtocols({ chain: 'Arbitrum', limit: 10 });
		expect(result.map((p) => p.slug).sort()).toEqual(['aave', 'gmx']);
	});

	it('caches by (chain, limit) — second call within TTL hits no network', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, PROTOCOLS_FIXTURE));
		await getProtocols({ limit: 5 });
		await getProtocols({ limit: 5 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('refetches once the protocols TTL (10 min) expires', async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, PROTOCOLS_FIXTURE));
		await getProtocols({ limit: 5 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(CACHE_TTL.protocols + 1000);
		await getProtocols({ limit: 5 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('getProtocol', () => {
	it('maps a single protocol detail by slug', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(200, {
				slug: 'aave',
				name: 'Aave',
				tvl: 20_000_000_000,
				category: 'Lending',
				chain: 'Ethereum',
				change_1d: 1.2,
				change_7d: -3.4,
				chains: ['Ethereum', 'Arbitrum'],
			}),
		);
		const result = await getProtocol('aave');
		expect(result).toEqual({
			slug: 'aave',
			name: 'Aave',
			tvl: 20_000_000_000,
			category: 'Lending',
			chain: 'Ethereum',
			change1d: 1.2,
			change7d: -3.4,
			chains: ['Ethereum', 'Arbitrum'],
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.llama.fi/protocol/aave',
			expect.any(Object),
		);
	});

	it('rejects a missing slug without hitting the network', async () => {
		await expect(getProtocol()).rejects.toThrow(/slug/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('getYieldPools', () => {
	it('filters by chain + stablecoin, sorts by TVL desc, applies limit', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, YIELDS_FIXTURE));
		const result = await getYieldPools({ chain: 'Arbitrum', stablecoin: true, limit: 3 });
		expect(result).toEqual([
			{ pool: 'p1', project: 'aave-v3', chain: 'Arbitrum', symbol: 'USDC', tvlUsd: 50_000_000, apy: 8.2, apyBase: 3.1, apyReward: 5.1, stablecoin: true, ilRisk: 'no' },
			{ pool: 'p4', project: 'gmx', chain: 'Arbitrum', symbol: 'USDC-ARB', tvlUsd: 10_000_000, apy: 15.4, apyBase: 4.0, apyReward: 11.4, stablecoin: true, ilRisk: 'yes' },
		]);
	});

	it('filters by project', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, YIELDS_FIXTURE));
		const result = await getYieldPools({ project: 'aave-v3', limit: 10 });
		expect(result.map((p) => p.pool).sort()).toEqual(['p1', 'p3']);
	});

	it('respects minTvl', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, YIELDS_FIXTURE));
		const result = await getYieldPools({ minTvl: 100_000_000, limit: 10 });
		expect(result.map((p) => p.pool)).toEqual(['p2']);
	});

	it('caches the unfiltered fetch and reslices in memory for a different limit', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, YIELDS_FIXTURE));
		await getYieldPools({ limit: 1 });
		await getYieldPools({ limit: 4 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('getChainTvls', () => {
	it('computes dominance percentages and sorts by TVL desc', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, CHAINS_FIXTURE));
		const result = await getChainTvls();
		expect(result[0]).toMatchObject({ name: 'Ethereum', tvl: 60_000_000_000 });
		expect(result[0].dominance).toBeCloseTo(60, 0);
		const total = result.reduce((sum, c) => sum + c.dominance, 0);
		expect(total).toBeCloseTo(100, 0);
	});
});

describe('getDexVolumes', () => {
	it('maps + sorts DEX protocols by 24h volume desc', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, DEX_FIXTURE));
		const result = await getDexVolumes();
		expect(result[0]).toEqual({ name: 'Uniswap', volume24h: 2_000_000_000, change1d: 4.2, chain: 'Ethereum, Arbitrum' });
	});

	it('filters by chain', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, DEX_FIXTURE));
		const result = await getDexVolumes({ chain: 'Solana' });
		expect(result.map((d) => d.name)).toEqual(['Raydium']);
	});
});

describe('getFearGreed', () => {
	it('maps the alternative.me shape to value/classification/timestamp', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, FNG_FIXTURE));
		const result = await getFearGreed();
		expect(result).toEqual({ value: 72, classification: 'Greed', timestamp: '1783670400' });
	});

	it('falls back to a neutral reading on a malformed payload', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
		const result = await getFearGreed();
		expect(result.value).toBe(50);
		expect(result.classification).toBe('Neutral');
	});

	it('caches for the fear/greed TTL (30 min)', async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, FNG_FIXTURE));
		await getFearGreed();
		await getFearGreed();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(CACHE_TTL.fearGreed + 1000);
		await getFearGreed();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('error propagation', () => {
	it('an upstream failure on getYieldPools rejects rather than returning fabricated data', async () => {
		fetchMock.mockResolvedValue(jsonResponse(500, {}));
		const promise = getYieldPools({ limit: 5 });
		promise.catch(() => {});
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(promise).rejects.toThrow(/HTTP 500/);
	});
});

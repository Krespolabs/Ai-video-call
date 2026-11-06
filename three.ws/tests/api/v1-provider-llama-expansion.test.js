// Tests for the DefiLlama provider's expanded endpoints (chains, protocol,
// chain-tvl) plus the two new sibling providers on DefiLlama's other bases —
// llama-prices (coins.llama.fi) and llama-stablecoins (stablecoins.llama.fi).
// api/v1/_providers.js is the single source of truth; these are pure
// descriptor/transform tests against fixtures trimmed from REAL captures on
// 2026-07-08, plus malformed payloads. No live network.

import { describe, it, expect } from 'vitest';
import { PROVIDERS, ENDPOINT_INDEX } from '../../api/v1/_providers.js';

const defillama = PROVIDERS.find((p) => p.id === 'defillama');
const dep = (id) => ENDPOINT_INDEX.get(`defillama/${id}`).endpoint;

describe('defillama provider — expanded descriptor integrity', () => {
	it('exposes protocols, tvl, chains, protocol, chain-tvl — all indexed and free-tiered', () => {
		expect(defillama.endpoints.map((e) => e.id)).toEqual(['protocols', 'tvl', 'chains', 'protocol', 'chain-tvl']);
		for (const id of ['chains', 'protocol', 'chain-tvl']) {
			const e = ENDPOINT_INDEX.get(`defillama/${id}`);
			expect(e, `defillama/${id} indexed`).toBeTruthy();
			expect(e.endpoint.method).toBe('GET');
			expect(e.endpoint.scope).toBe('agents:read');
			expect(e.endpoint.free).toEqual({ perMin: 30, perDay: 2000 });
			expect(typeof e.endpoint.summary).toBe('string');
		}
	});
});

describe('defillama/chains', () => {
	const CHAINS_FIXTURE = [
		{ gecko_id: 'harmony', tvl: 203131.77, tokenSymbol: 'ONE', chainId: 1666600000 },
		{ gecko_id: null, tvl: 95716125.93, tokenSymbol: null, chainId: 4663, name: 'Robinhood Chain' },
		{ gecko_id: 'ethereum', tvl: 55000000000, tokenSymbol: 'ETH', chainId: 1, name: 'Ethereum' },
	];

	it('slims and sorts by tvl desc', () => {
		const out = dep('chains').transform(CHAINS_FIXTURE);
		expect(out.map((c) => c.tokenSymbol)).toEqual(['ETH', null, 'ONE']);
		expect(out[0]).toEqual({ name: 'Ethereum', tvl: 55000000000, tokenSymbol: 'ETH', chainId: 1 });
	});

	it('tolerates malformed payloads', () => {
		expect(dep('chains').transform(null)).toEqual([]);
		expect(dep('chains').transform({})).toEqual([]);
	});
});

describe('defillama/protocol', () => {
	const PROTOCOL_FIXTURE = {
		name: 'Uniswap',
		category: 'Dexes',
		chains: ['Ethereum', 'Base', 'Arbitrum'],
		currentChainTvls: { Ethereum: 2110431947, Base: 411425289 },
		mcap: 5000000000,
		tvl: Array.from({ length: 50 }, (_, i) => ({ date: 1600000000 + i * 86400, totalLiquidityUSD: 1000 + i })),
	};

	it('slims to name/category/chains/current + last 30 tvl points', () => {
		const out = dep('protocol').transform(PROTOCOL_FIXTURE);
		expect(out.name).toBe('Uniswap');
		expect(out.category).toBe('Dexes');
		expect(out.chains).toEqual(['Ethereum', 'Base', 'Arbitrum']);
		expect(out.current_chain_tvls_usd).toEqual({ Ethereum: 2110431947, Base: 411425289 });
		expect(out.mcap_usd).toBe(5000000000);
		expect(out.tvl_usd).toHaveLength(30);
		expect(out.tvl_usd[0]).toEqual({ date: PROTOCOL_FIXTURE.tvl[20].date, tvl: PROTOCOL_FIXTURE.tvl[20].totalLiquidityUSD });
	});

	it('handles a short tvl series and malformed payloads', () => {
		expect(dep('protocol').transform({ name: 'x', tvl: [] }).tvl_usd).toEqual([]);
		expect(dep('protocol').transform(null)).toBeNull();
	});

	it('requires slug', () => {
		expect(() => dep('protocol').path({})).toThrow(/slug/);
		expect(dep('protocol').path({ slug: 'uniswap' })).toBe('/protocol/uniswap');
	});
});

describe('defillama/chain-tvl', () => {
	const SERIES_FIXTURE = Array.from({ length: 120 }, (_, i) => ({ date: 1600000000 + i * 86400, tvl: 100 + i }));

	it('slims to the last 90 points', () => {
		const out = dep('chain-tvl').transform(SERIES_FIXTURE);
		expect(out).toHaveLength(90);
		expect(out[0]).toEqual({ date: SERIES_FIXTURE[30].date, tvl: SERIES_FIXTURE[30].tvl });
		expect(out[89]).toEqual({ date: SERIES_FIXTURE[119].date, tvl: SERIES_FIXTURE[119].tvl });
	});

	it('tolerates malformed payloads', () => {
		expect(dep('chain-tvl').transform(null)).toEqual([]);
	});

	it('requires chain', () => {
		expect(() => dep('chain-tvl').path({})).toThrow(/chain/);
		expect(dep('chain-tvl').path({ chain: 'Solana' })).toBe('/v2/historicalChainTvl/Solana');
	});
});

// ── llama-prices ─────────────────────────────────────────────────────────────
describe('llama-prices provider', () => {
	const provider = PROVIDERS.find((p) => p.id === 'llama-prices');
	const pep = (id) => ENDPOINT_INDEX.get(`llama-prices/${id}`).endpoint;

	it('is registered as a keyless provider on coins.llama.fi', () => {
		expect(provider).toBeTruthy();
		expect(provider.base).toBe('https://coins.llama.fi');
		expect(provider.requiresKey).toBe(false);
		expect(provider.endpoints.map((e) => e.id)).toEqual(['current']);
		expect(pep('current').free).toEqual({ perMin: 30, perDay: 2000 });
	});

	it('current — normalizes the coins map and requires "coins"', () => {
		const fixture = {
			coins: {
				'solana:FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump': {
					decimals: 6,
					symbol: 'THREE',
					price: 0.0012908347845446426,
					timestamp: 1783468699,
					confidence: 0.99,
				},
			},
		};
		expect(pep('current').transform(fixture)).toEqual({
			'solana:FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump': {
				price: 0.0012908347845446426,
				symbol: 'THREE',
				decimals: 6,
				timestamp: 1783468699,
				confidence: 0.99,
			},
		});
		expect(() => pep('current').path({})).toThrow(/coins/);
	});

	it('tolerates malformed payloads', () => {
		expect(pep('current').transform(null)).toEqual({});
		expect(pep('current').transform({})).toEqual({});
	});
});

// ── llama-stablecoins ────────────────────────────────────────────────────────
describe('llama-stablecoins provider', () => {
	const provider = PROVIDERS.find((p) => p.id === 'llama-stablecoins');
	const sep = (id) => ENDPOINT_INDEX.get(`llama-stablecoins/${id}`).endpoint;

	it('is registered as a keyless provider on stablecoins.llama.fi', () => {
		expect(provider).toBeTruthy();
		expect(provider.base).toBe('https://stablecoins.llama.fi');
		expect(provider.category).toBe('defi-data');
		expect(provider.endpoints.map((e) => e.id)).toEqual(['list']);
	});

	it('list — slims, sorts by circulating desc, caps 50', () => {
		const assets = Array.from({ length: 60 }, (_, i) => ({
			name: `Stable${i}`,
			symbol: `S${i}`,
			pegType: 'peggedUSD',
			price: 1,
			circulating: { peggedUSD: i },
			circulatingPrevDay: { peggedUSD: i - 1 },
		}));
		const out = sep('list').transform({ peggedAssets: assets });
		expect(out).toHaveLength(50);
		expect(out[0].circulating_usd).toBe(59);
		expect(out[0]).toEqual({
			name: 'Stable59',
			symbol: 'S59',
			pegType: 'peggedUSD',
			price: 1,
			circulating_usd: 59,
			circulating_prev_day_usd: 58,
		});
	});

	it('always sends includePrices=true and tolerates malformed payloads', () => {
		expect(sep('list').query({})).toEqual({ includePrices: 'true' });
		expect(sep('list').transform(null)).toEqual([]);
		expect(sep('list').transform({})).toEqual([]);
	});
});

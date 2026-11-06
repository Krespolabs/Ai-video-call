// Tests for the CoinGecko provider's expanded endpoints (api/v1/_providers.js):
// coin, trending, token-price, global, ohlc — added alongside the original
// price/markets pair to give agents real coverage instead of two endpoints.
//
// No live network: transforms are pure functions, exercised against fixtures
// trimmed from REAL captures against api.coingecko.com on 2026-07-08 (full
// per-currency objects trimmed to `usd` only — the transform only ever reads
// `.usd`, so this is a faithful shape, not a mock of our own code) plus
// malformed payloads. Descriptor integrity + required-param enforcement via
// ENDPOINT_INDEX and the query() builders.

import { describe, it, expect } from 'vitest';
import { PROVIDERS, ENDPOINT_INDEX } from '../../api/v1/_providers.js';

const coingecko = PROVIDERS.find((p) => p.id === 'coingecko');
const ep = (id) => ENDPOINT_INDEX.get(`coingecko/${id}`).endpoint;

describe('coingecko provider — descriptor integrity', () => {
	it('exposes price, markets, coin, trending, token-price, global, ohlc — all indexed and free-tiered', () => {
		expect(coingecko.endpoints.map((e) => e.id)).toEqual([
			'price',
			'markets',
			'coin',
			'trending',
			'token-price',
			'global',
			'ohlc',
		]);
		for (const id of ['coin', 'trending', 'token-price', 'global', 'ohlc']) {
			const e = ENDPOINT_INDEX.get(`coingecko/${id}`);
			expect(e, `coingecko/${id} indexed`).toBeTruthy();
			expect(e.endpoint.method).toBe('GET');
			expect(e.endpoint.scope).toBe('agents:read');
			expect(e.endpoint.free).toEqual({ perMin: 20, perDay: 1500 });
			expect(typeof e.endpoint.summary).toBe('string');
			expect(e.endpoint.summary.length).toBeGreaterThan(0);
			expect(e.endpoint.params).toBeTruthy();
		}
	});
});

// ── coin ─────────────────────────────────────────────────────────────────────
describe('coingecko/coin', () => {
	const COIN_FIXTURE = {
		id: 'solana',
		symbol: 'sol',
		name: 'Solana',
		market_cap_rank: 7,
		description: { en: 'Solana is a high-performance Layer 1 blockchain. '.repeat(30) },
		market_data: {
			current_price: { usd: 80.4 },
			ath: { usd: 293.31 },
			ath_change_percentage: { usd: -72.6 },
			atl: { usd: 0.500801 },
			atl_change_percentage: { usd: 15960.2 },
			market_cap: { usd: 46794500862 },
			fully_diluted_valuation: { usd: 50700000000 },
			total_volume: { usd: 2179803115 },
			circulating_supply: 581713615.3253177,
			total_supply: 629846029.4214532,
			max_supply: null,
			price_change_percentage_24h: -2.16777,
			price_change_percentage_7d: 9.76133,
			price_change_percentage_30d: 5.1,
			last_updated: '2026-07-08T00:00:00.000Z',
		},
	};

	it('slims to market essentials with description truncated to 500 chars', () => {
		const out = ep('coin').transform(COIN_FIXTURE);
		expect(out).toMatchObject({
			id: 'solana',
			symbol: 'sol',
			name: 'Solana',
			market_cap_rank: 7,
			price_usd: 80.4,
			ath_usd: 293.31,
			atl_usd: 0.500801,
			market_cap_usd: 46794500862,
			total_volume_usd: 2179803115,
			circulating_supply: 581713615.3253177,
			price_change_percentage_24h: -2.16777,
			price_change_percentage_7d: 9.76133,
		});
		expect(out.description.length).toBe(500);
	});

	it('tolerates a null description and malformed payloads', () => {
		expect(() => ep('coin').transform({ ...COIN_FIXTURE, description: undefined })).not.toThrow();
		expect(ep('coin').transform(null)).toBeNull();
		expect(ep('coin').transform('nope')).toBe('nope');
	});

	it('requires id and applies the four flatten flags', () => {
		expect(() => ep('coin').path({})).toThrow(/id/);
		const q = ep('coin').query({ id: 'solana' });
		expect(q).toEqual({
			localization: 'false',
			tickers: 'false',
			community_data: 'false',
			developer_data: 'false',
		});
	});
});

// ── trending ─────────────────────────────────────────────────────────────────
describe('coingecko/trending', () => {
	const TRENDING_FIXTURE = {
		coins: [
			{ item: { id: 'solana', symbol: 'sol', name: 'Solana', market_cap_rank: 7, price_btc: 0.00126444 } },
		],
		categories: [
			{ id: 107, name: 'Launchpad', slug: 'launchpad', coins_count: '198', data: { market_cap: 5354790876.7 } },
		],
	};

	it('slims coins and categories', () => {
		const out = ep('trending').transform(TRENDING_FIXTURE);
		expect(out).toEqual({
			coins: [{ id: 'solana', symbol: 'sol', name: 'Solana', market_cap_rank: 7, price_btc: 0.00126444 }],
			categories: [{ id: 107, name: 'Launchpad', slug: 'launchpad', coins_count: '198', market_cap_usd: 5354790876.7 }],
		});
	});

	it('tolerates malformed payloads', () => {
		expect(ep('trending').transform(null)).toEqual({ coins: [], categories: [] });
		expect(ep('trending').transform({})).toEqual({ coins: [], categories: [] });
	});

	it('takes no required params', () => {
		expect(ep('trending').query({})).toEqual({});
	});
});

// ── token-price ──────────────────────────────────────────────────────────────
describe('coingecko/token-price', () => {
	it('defaults platform to solana and requires addresses', () => {
		expect(() => ep('token-price').query({})).toThrow(/addresses/);
		expect(
			ep('token-price').query({ addresses: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' }),
		).toEqual({
			contract_addresses: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
			vs_currencies: 'usd',
		});
	});

	it('honors an explicit platform + vs_currencies', () => {
		expect(ep('token-price').path({ platform: 'ethereum' })).toBe('/simple/token_price/ethereum');
		expect(
			ep('token-price').query({ addresses: '0xabc', vs_currencies: 'eur' }),
		).toEqual({ contract_addresses: '0xabc', vs_currencies: 'eur' });
	});
});

// ── global ───────────────────────────────────────────────────────────────────
describe('coingecko/global', () => {
	const GLOBAL_FIXTURE = {
		data: {
			active_cryptocurrencies: 17339,
			markets: 1493,
			total_market_cap: { usd: 2274686337878.679 },
			total_volume: { usd: 91000000000 },
			market_cap_percentage: { btc: 55.2, eth: 12.1 },
			market_cap_change_percentage_24h_usd: -1.2,
			updated_at: 1783468699,
		},
	};

	it('slims to the market snapshot fields', () => {
		expect(ep('global').transform(GLOBAL_FIXTURE)).toEqual({
			active_cryptocurrencies: 17339,
			markets: 1493,
			total_market_cap_usd: 2274686337878.679,
			total_volume_usd: 91000000000,
			btc_dominance: 55.2,
			eth_dominance: 12.1,
			market_cap_change_percentage_24h_usd: -1.2,
			updated_at: 1783468699,
		});
	});

	it('tolerates a missing data block', () => {
		expect(ep('global').transform({})).toMatchObject({ active_cryptocurrencies: undefined });
		expect(ep('global').transform(null)).toMatchObject({ active_cryptocurrencies: undefined });
	});
});

// ── ohlc ─────────────────────────────────────────────────────────────────────
describe('coingecko/ohlc', () => {
	const OHLC_FIXTURE = [
		[1783386000000, 82.27, 82.34, 82.22, 82.3],
		[1783387800000, 82.32, 82.32, 82.0, 82.0],
	];

	it('maps each candle to a named object', () => {
		expect(ep('ohlc').transform(OHLC_FIXTURE)).toEqual([
			{ t: 1783386000000, o: 82.27, h: 82.34, l: 82.22, c: 82.3 },
			{ t: 1783387800000, o: 82.32, h: 82.32, l: 82.0, c: 82.0 },
		]);
	});

	it('tolerates malformed payloads', () => {
		expect(ep('ohlc').transform(null)).toEqual([]);
		expect(ep('ohlc').transform('nope')).toEqual([]);
	});

	it('requires id and clamps days to the allowed set', () => {
		expect(() => ep('ohlc').path({})).toThrow(/id/);
		expect(ep('ohlc').query({ id: 'solana' })).toEqual({ vs_currency: 'usd', days: '1' });
		expect(ep('ohlc').query({ id: 'solana', days: '7' })).toEqual({ vs_currency: 'usd', days: '7' });
		expect(ep('ohlc').query({ id: 'solana', days: '999' })).toEqual({ vs_currency: 'usd', days: '1' });
	});
});

// Tests for the DexScreener aggregator provider (api/v1/_providers.js).
//
// DexScreener is a keyless public API — no key, no BYOK header. This provider
// replaces the paid token-intel/three-intel DexScreener passthroughs with the
// honest free surface agents can already get at the source.
//
// No live network here — the descriptor's transforms are pure functions, so we
// exercise them against fixtures captured from the REAL api.dexscreener.com on
// 2026-07-08 (verified live: /latest/dex/tokens/{addr}, /latest/dex/search,
// /latest/dex/pairs/{chain}/{pair}, /token-profiles/latest/v1,
// /token-boosts/latest/v1 — the $THREE mint used throughout) plus malformed
// payloads, and assert descriptor integrity via ENDPOINT_INDEX and
// required-param enforcement via the path()/query() builders.

import { describe, it, expect } from 'vitest';
import { PROVIDERS, ENDPOINT_INDEX } from '../../api/v1/_providers.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const dexscreener = PROVIDERS.find((p) => p.id === 'dexscreener');
const ep = (id) => ENDPOINT_INDEX.get(`dexscreener/${id}`).endpoint;

// ── Fixtures: trimmed but real-shaped captures from api.dexscreener.com ──────
// Captured live 2026-07-08 for the $THREE mint on its deepest pumpswap pair.
const PAIR = {
	chainId: 'solana',
	dexId: 'pumpswap',
	url: 'https://dexscreener.com/solana/5byl7mzolabynwmpzkpkjf4mgkz7febzranos19pre2z',
	pairAddress: '5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z',
	baseToken: { address: THREE_MINT, name: 'three.ws', symbol: 'three' },
	quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
	priceNative: '0.00001627',
	priceUsd: '0.001311',
	txns: { m5: { buys: 3, sells: 1 }, h1: { buys: 322, sells: 139 }, h6: { buys: 5792, sells: 1973 }, h24: { buys: 21764, sells: 8364 } },
	volume: { h24: 355485.08, h6: 58293.76, h1: 6777.49, m5: 346.6 },
	priceChange: { m5: 1.12, h1: 1.1, h6: -17.02, h24: -11.46 },
	liquidity: { usd: 183541.34, base: 69958010, quote: 1138.3755 },
	fdv: 1311470,
	marketCap: 1311470,
	pairCreatedAt: 1777446541000,
	info: {
		imageUrl: 'https://cdn.dexscreener.com/cms/images/j22gRd6Z2GowwOvM?width=800&height=800&quality=95&format=auto',
		websites: [{ url: 'https://three.ws/', label: 'Website' }],
		socials: [{ url: 'https://x.com/trythreews', type: 'twitter' }],
	},
	boosts: { active: 10 },
};

const LOW_LIQ_PAIR = {
	chainId: 'solana',
	dexId: 'raydium',
	pairAddress: 'LowLiqPairAddress1111111111111111111111111',
	baseToken: { address: THREE_MINT, name: 'three.ws', symbol: 'three' },
	quoteToken: { symbol: 'USDC' },
	priceUsd: '0.001300',
	liquidity: { usd: 500 },
	volume: { h24: 10 },
	priceChange: { h24: -1 },
	txns: { h24: { buys: 1, sells: 0 } },
};

const PAIRS_RESPONSE = { schemaVersion: '1.0.0', pairs: [LOW_LIQ_PAIR, PAIR] };

const PROFILE = {
	url: 'https://dexscreener.com/solana/d41maqylwbehvzprm674oyiqwa4ghyt9zxw4ckq3pump',
	chainId: 'solana',
	tokenAddress: 'D41mAqyLwbEhVZpRM674oyiQWa4ghYT9zXw4CKQ3pump',
	icon: 'https://cdn.dexscreener.com/cms/images/EfOCKeRcqdv7b_lA?width=64&height=64&fit=crop&quality=95&format=auto',
	description: 'The White Whale LIVE on pumpfun',
	links: [{ type: 'twitter', url: 'https://x.com/i/communities/2036583572375740715' }],
	cto: false,
	updatedAt: '2026-07-08T00:38:43.039Z',
};

const BOOST = {
	url: 'https://dexscreener.com/solana/7aj9sdzw6sodb8ajnekesewtqvvhyz4gg85h3c1ypump',
	chainId: 'solana',
	tokenAddress: '7AJ9sdZW6Sodb8ajnEkESeWtQVVHyZ4Gg85H3c1Ypump',
	description: 'The Rizzler is the king of all bulls, he runs the trenches.',
	icon: 'ALdFj3-jvz_VfihQ',
	links: [
		{ type: 'twitter', url: 'https://x.com/i/communities/2000665667108774278' },
		{ type: 'telegram', url: 'https://t.me/rizzbull' },
	],
	totalAmount: 60,
	amount: 10,
};

describe('dexscreener provider — descriptor integrity', () => {
	it('is registered as a keyless crypto-market-data provider', () => {
		expect(dexscreener).toBeTruthy();
		expect(dexscreener.category).toBe('crypto-market-data');
		expect(dexscreener.base).toBe('https://api.dexscreener.com');
		expect(dexscreener.requiresKey).toBe(false);
		expect(dexscreener.byokHeader).toBeNull();
		expect(dexscreener.envVar).toBeNull();
	});

	it('exposes token, search, pair, profiles, boosts — all indexed, GET, scoped, priced, free-tiered', () => {
		expect(dexscreener.endpoints.map((e) => e.id)).toEqual(['token', 'search', 'pair', 'profiles', 'boosts']);
		for (const id of ['token', 'search', 'pair', 'profiles', 'boosts']) {
			const e = ENDPOINT_INDEX.get(`dexscreener/${id}`);
			expect(e, `dexscreener/${id} indexed`).toBeTruthy();
			expect(e.endpoint.method).toBe('GET');
			expect(e.endpoint.scope).toBe('agents:read');
			expect(e.endpoint.priceAtomics).toBe('1000');
			expect(typeof e.endpoint.summary).toBe('string');
			expect(e.endpoint.summary.length).toBeGreaterThan(0);
			expect(e.endpoint.params).toBeTruthy();
		}
	});

	it('sets tighter free quotas for profiles/boosts than the pair endpoints', () => {
		for (const id of ['token', 'search', 'pair']) {
			expect(ep(id).free).toEqual({ perMin: 30, perDay: 3000 });
		}
		for (const id of ['profiles', 'boosts']) {
			expect(ep(id).free).toEqual({ perMin: 10, perDay: 500 });
		}
	});
});

describe('dexscreener/token — path + transform', () => {
	it('requires addresses and caps the path at 30 comma-separated entries', () => {
		expect(() => ep('token').path({})).toThrow(/addresses/);
		expect(ep('token').path({ addresses: THREE_MINT })).toBe(`/latest/dex/tokens/${THREE_MINT}`);
		const many = Array.from({ length: 40 }, (_, i) => `mint${i}`).join(',');
		const path = ep('token').path({ addresses: many });
		expect(decodeURIComponent(path).split(',')).toHaveLength(30);
	});

	it('slims pairs to the agent-useful subset, sorted by liquidity desc', () => {
		const out = ep('token').transform(PAIRS_RESPONSE);
		expect(out).toEqual([
			{
				chainId: 'solana',
				dexId: 'pumpswap',
				pairAddress: '5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z',
				baseToken: { address: THREE_MINT, name: 'three.ws', symbol: 'three' },
				quoteToken: { symbol: 'SOL' },
				priceUsd: '0.001311',
				priceNative: '0.00001627',
				liquidity: { usd: 183541.34 },
				fdv: 1311470,
				marketCap: 1311470,
				volume: { h24: 355485.08 },
				priceChange: { h1: 1.1, h6: -17.02, h24: -11.46 },
				txns: { h24: { buys: 21764, sells: 8364 } },
				pairCreatedAt: 1777446541000,
				url: 'https://dexscreener.com/solana/5byl7mzolabynwmpzkpkjf4mgkz7febzranos19pre2z',
			},
			{
				chainId: 'solana',
				dexId: 'raydium',
				pairAddress: 'LowLiqPairAddress1111111111111111111111111',
				baseToken: { address: THREE_MINT, name: 'three.ws', symbol: 'three' },
				quoteToken: { symbol: 'USDC' },
				priceUsd: '0.001300',
				priceNative: null,
				liquidity: { usd: 500 },
				fdv: null,
				marketCap: null,
				volume: { h24: 10 },
				priceChange: { h1: null, h6: null, h24: -1 },
				txns: { h24: { buys: 1, sells: 0 } },
				pairCreatedAt: null,
				url: null,
			},
		]);
	});

	it('caps at 30 pairs and tolerates malformed payloads', () => {
		const many = { pairs: Array.from({ length: 50 }, (_, i) => ({ ...PAIR, pairAddress: `p${i}`, liquidity: { usd: i } })) };
		expect(ep('token').transform(many)).toHaveLength(30);
		expect(ep('token').transform(null)).toEqual([]);
		expect(ep('token').transform({})).toEqual([]);
		expect(ep('token').transform({ pairs: null })).toEqual([]);
		expect(ep('token').transform({ pairs: [null, {}] })).toHaveLength(1);
	});
});

describe('dexscreener/search — path + transform', () => {
	it('requires q and caps at 20 pairs', () => {
		expect(() => ep('search').query({})).toThrow(/q/);
		expect(ep('search').query({ q: 'three.ws' })).toEqual({ q: 'three.ws' });
		const many = { pairs: Array.from({ length: 30 }, (_, i) => ({ ...PAIR, pairAddress: `p${i}` })) };
		expect(ep('search').transform(many)).toHaveLength(20);
	});
});

describe('dexscreener/pair — path + transform', () => {
	it('requires chain and pair, builds the path-param style route', () => {
		expect(() => ep('pair').path({ pair: 'x' })).toThrow(/chain/);
		expect(() => ep('pair').path({ chain: 'solana' })).toThrow(/pair/);
		expect(ep('pair').path({ chain: 'solana', pair: '5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z' })).toBe(
			'/latest/dex/pairs/solana/5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z',
		);
	});

	it('slims the returned pair the same way as token/search', () => {
		const out = ep('pair').transform({ schemaVersion: '1.0.0', pairs: [PAIR] });
		expect(out[0].pairAddress).toBe('5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z');
		expect(out[0]).not.toHaveProperty('info');
		expect(out[0]).not.toHaveProperty('boosts');
	});
});

describe('dexscreener/profiles — transform', () => {
	it('slims each profile to chainId/tokenAddress/description/links, cap 30', () => {
		const out = ep('profiles').transform([PROFILE]);
		expect(out).toEqual([
			{
				chainId: 'solana',
				tokenAddress: 'D41mAqyLwbEhVZpRM674oyiQWa4ghYT9zXw4CKQ3pump',
				description: 'The White Whale LIVE on pumpfun',
				links: [{ type: 'twitter', url: 'https://x.com/i/communities/2036583572375740715' }],
			},
		]);
	});

	it('caps at 30 and tolerates malformed payloads', () => {
		const many = Array.from({ length: 50 }, (_, i) => ({ ...PROFILE, tokenAddress: `t${i}` }));
		expect(ep('profiles').transform(many)).toHaveLength(30);
		expect(ep('profiles').transform(null)).toEqual([]);
		expect(ep('profiles').transform({})).toEqual([]);
		expect(ep('profiles').transform([null, {}])).toHaveLength(1);
	});
});

describe('dexscreener/boosts — transform', () => {
	it('slims each boosted token the same way as profiles', () => {
		const out = ep('boosts').transform([BOOST]);
		expect(out).toEqual([
			{
				chainId: 'solana',
				tokenAddress: '7AJ9sdZW6Sodb8ajnEkESeWtQVVHyZ4Gg85H3c1Ypump',
				description: 'The Rizzler is the king of all bulls, he runs the trenches.',
				links: [
					{ type: 'twitter', url: 'https://x.com/i/communities/2000665667108774278' },
					{ type: 'telegram', url: 'https://t.me/rizzbull' },
				],
			},
		]);
	});

	it('tolerates malformed payloads', () => {
		expect(ep('boosts').transform(null)).toEqual([]);
		expect(ep('boosts').transform('rate limited')).toEqual([]);
	});
});

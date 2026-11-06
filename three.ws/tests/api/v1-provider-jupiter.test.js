// Tests for the Jupiter aggregator provider (api/v1/_providers.js).
//
// Jupiter's keyless "lite" tier gives agents three free, high-value Solana
// calls through the unified three.ws API: live token prices, executable swap
// quotes (the true routed price, not a mid-market estimate), and token search.
//
// No live network here — the descriptor's transforms are pure functions, so we
// exercise them against fixtures captured from the REAL lite-api.jup.ag on
// 2026-07-06 (versions verified: /price/v3, /swap/v1/quote, /tokens/v2/search)
// plus malformed payloads, and assert descriptor integrity via ENDPOINT_INDEX
// and required-param enforcement via the query() builders.

import { describe, it, expect } from 'vitest';
import { PROVIDERS, ENDPOINT_INDEX } from '../../api/v1/_providers.js';

const jupiter = PROVIDERS.find((p) => p.id === 'jupiter');
const ep = (id) => ENDPOINT_INDEX.get(`jupiter/${id}`).endpoint;

// ── Fixtures: trimmed but real-shaped captures from lite-api.jup.ag ───────────
const PRICE_FIXTURE = {
	FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump: {
		createdAt: '2026-04-29T05:41:49Z',
		liquidity: 217828.6725114084,
		usdPrice: 0.0016321026673506269,
		blockId: 431244672,
		decimals: 6,
		priceChange24h: 4.548816264001991,
		launchpad: 'pump.fun',
	},
	So11111111111111111111111111111111111111112: {
		createdAt: '2024-06-05T08:55:25.527Z',
		liquidity: 688122254.2024628,
		usdPrice: 82.49319522938384,
		blockId: 431244687,
		decimals: 9,
		priceChange24h: 1.1801959999610383,
	},
};

const QUOTE_FIXTURE = {
	inputMint: 'So11111111111111111111111111111111111111112',
	inAmount: '1000000000',
	outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	outAmount: '82520581',
	otherAmountThreshold: '82107979',
	swapMode: 'ExactIn',
	slippageBps: 50,
	platformFee: null,
	priceImpactPct: '0',
	routePlan: [
		{
			swapInfo: {
				ammKey: '8R5qdXKMn2KcfHBy9rEpi43KScHewqvRAcpFyqoL3wap',
				label: 'Quantum',
				inputMint: 'So11111111111111111111111111111111111111112',
				outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				inAmount: '1000000000',
				outAmount: '82520581',
			},
			percent: 100,
			bps: null,
		},
	],
	contextSlot: 431244698,
	timeTaken: 0.001351873,
	swapUsdValue: '82.45175776511278468757404683',
	mostReliableAmmsQuoteReport: { info: { foo: '1', bar: '2' } },
};

const SEARCH_FIXTURE = [
	{
		id: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		name: 'three.ws',
		symbol: 'three',
		icon: 'https://ipfs.io/ipfs/bafybeihe22b5sxr3ihnxt7pregfieyteqvubqhik3j3y4bbx243xlqjw3q',
		decimals: 6,
		tags: ['token-2022', 'verified', 'moonshot-verified'],
		usdPrice: 0.0016146354029005611,
		mcap: 1614124.408731268,
		holderCount: 14754,
		stats24h: { buyVolume: 346052.3096565032, sellVolume: 338862.090834 },
	},
];

describe('jupiter provider — descriptor integrity', () => {
	it('is registered as a keyless crypto-market-data provider on the lite base', () => {
		expect(jupiter).toBeTruthy();
		expect(jupiter.category).toBe('crypto-market-data');
		expect(jupiter.base).toBe('https://lite-api.jup.ag');
		expect(jupiter.requiresKey).toBe(false);
		expect(jupiter.byokHeader).toBeNull();
		expect(jupiter.envVar).toBeNull();
	});

	it('exposes exactly price, quote, token-search — all indexed, GET, scoped, priced, free-tiered', () => {
		expect(jupiter.endpoints.map((e) => e.id)).toEqual(['price', 'quote', 'token-search']);
		for (const id of ['price', 'quote', 'token-search']) {
			const e = ENDPOINT_INDEX.get(`jupiter/${id}`);
			expect(e, `jupiter/${id} indexed`).toBeTruthy();
			expect(e.endpoint.method).toBe('GET');
			expect(e.endpoint.scope).toBe('agents:read');
			expect(e.endpoint.priceAtomics).toBe('1000');
			expect(e.endpoint.free).toEqual({ perMin: 20, perDay: 2000 });
			expect(typeof e.endpoint.summary).toBe('string');
			expect(e.endpoint.summary.length).toBeGreaterThan(0);
			expect(e.endpoint.params).toBeTruthy();
		}
	});
});

describe('jupiter/price — transform', () => {
	const t = ep('price').transform;

	it('flattens each mint to normalized price fields', () => {
		const out = t(PRICE_FIXTURE);
		expect(out).toEqual({
			FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump: {
				price_usd: 0.0016321026673506269,
				decimals: 6,
				price_change_24h: 4.548816264001991,
				liquidity: 217828.6725114084,
				block_id: 431244672,
			},
			So11111111111111111111111111111111111111112: {
				price_usd: 82.49319522938384,
				decimals: 9,
				price_change_24h: 1.1801959999610383,
				liquidity: 688122254.2024628,
				block_id: 431244687,
			},
		});
	});

	it('returns {} for an unknown mint (upstream returns {})', () => {
		expect(t({})).toEqual({});
	});

	it('tolerates malformed payloads', () => {
		expect(t(null)).toEqual({});
		expect(t('Route not found')).toEqual({});
		expect(t([])).toEqual({});
		expect(t({ MINT: null })).toEqual({});
	});

	it('requires ids', () => {
		expect(() => ep('price').query({})).toThrow(/ids/);
		expect(ep('price').query({ ids: 'MINT' })).toEqual({ ids: 'MINT' });
	});
});

describe('jupiter/quote — transform', () => {
	const t = ep('quote').transform;

	it('keeps amounts + impact and slims the route plan to label/mints/percent', () => {
		const out = t(QUOTE_FIXTURE);
		expect(out).toEqual({
			inputMint: 'So11111111111111111111111111111111111111112',
			outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			inAmount: '1000000000',
			outAmount: '82520581',
			otherAmountThreshold: '82107979',
			swapMode: 'ExactIn',
			slippageBps: 50,
			priceImpactPct: '0',
			routePlan: [
				{
					label: 'Quantum',
					inputMint: 'So11111111111111111111111111111111111111112',
					outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
					percent: 100,
				},
			],
		});
		// Heavy fields are dropped.
		expect(out).not.toHaveProperty('mostReliableAmmsQuoteReport');
		expect(out).not.toHaveProperty('contextSlot');
		expect(out).not.toHaveProperty('swapUsdValue');
	});

	it('yields an empty routePlan when the field is missing', () => {
		expect(t({ inAmount: '1', outAmount: '2' }).routePlan).toEqual([]);
	});

	it('tolerates malformed payloads', () => {
		expect(t(null)).toBeNull();
		expect(t('Route not found')).toBe('Route not found');
	});

	it('requires inputMint, outputMint, amount and defaults slippageBps to 50', () => {
		const q = ep('quote').query;
		expect(() => q({ outputMint: 'B', amount: '1' })).toThrow(/inputMint/);
		expect(() => q({ inputMint: 'A', amount: '1' })).toThrow(/outputMint/);
		expect(() => q({ inputMint: 'A', outputMint: 'B' })).toThrow(/amount/);
		expect(q({ inputMint: 'A', outputMint: 'B', amount: '1' })).toEqual({
			inputMint: 'A',
			outputMint: 'B',
			amount: '1',
			slippageBps: '50',
		});
		expect(q({ inputMint: 'A', outputMint: 'B', amount: '1', slippageBps: '100' }).slippageBps).toBe('100');
	});
});

describe('jupiter/token-search — transform', () => {
	const t = ep('token-search').transform;

	it('slims each hit and derives daily_volume from the 24h buy/sell split', () => {
		const out = t(SEARCH_FIXTURE);
		expect(out).toEqual([
			{
				address: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
				name: 'three.ws',
				symbol: 'three',
				decimals: 6,
				logoURI: 'https://ipfs.io/ipfs/bafybeihe22b5sxr3ihnxt7pregfieyteqvubqhik3j3y4bbx243xlqjw3q',
				tags: ['token-2022', 'verified', 'moonshot-verified'],
				daily_volume: 346052.3096565032 + 338862.090834,
			},
		]);
	});

	it('leaves daily_volume/tags undefined when the source omits them', () => {
		const out = t([{ id: 'M', name: 'n', symbol: 's', decimals: 0 }]);
		expect(out[0].daily_volume).toBeUndefined();
		expect(out[0].tags).toBeUndefined();
	});

	it('caps at 20 hits', () => {
		const many = Array.from({ length: 50 }, (_, i) => ({ id: `M${i}`, symbol: `S${i}` }));
		expect(t(many)).toHaveLength(20);
	});

	it('tolerates malformed payloads (empty search returns [])', () => {
		expect(t([])).toEqual([]);
		expect(t(null)).toEqual([]);
		expect(t('Route not found')).toEqual([]);
	});

	it('requires query', () => {
		expect(() => ep('token-search').query({})).toThrow(/query/);
		expect(ep('token-search').query({ query: 'three.ws' })).toEqual({ query: 'three.ws' });
	});
});

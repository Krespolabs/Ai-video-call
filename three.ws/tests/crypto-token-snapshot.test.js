import { describe, it, expect } from 'vitest';

import {
	SNAPSHOT_FIELDS,
	emptySnapshot,
	snapshotFromMarket,
	mergePumpCoin,
	mergeMeta,
	isBareMeta,
	composeTokenSnapshot,
} from '../api/_lib/crypto-token-snapshot.js';

// Synthetic addresses only — never a real third-party mint in fixtures (CLAUDE.md).
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SYNTH = 'THREEsynthetic1111111111111111111111111111A';
const EVM = '0x1111111111111111111111111111111111111111';

const fullMarket = {
	mint: THREE,
	symbol: 'THREE',
	name: 'three.ws',
	chain: 'solana',
	dex: 'pumpswap',
	pair_url: `https://dexscreener.com/solana/${THREE}`,
	price_usd: 0.0031,
	change_24h: 4.2,
	market_cap_usd: 3_100_000,
	fdv_usd: 3_100_000,
	liquidity_usd: 250_000,
	volume_24h_usd: 91_000,
	pair_created_at: 1750000000000,
};

const pumpCoin = {
	mint: SYNTH,
	name: 'synthetic sample',
	symbol: 'SYNTH',
	usd_market_cap: 42_000,
	bonding_curve: 'curveAcct',
	real_token_reserves: 500_000_000 * 1e6,
	real_sol_reserves: 30 * 1e9,
};

const never = () => { throw new Error('must not be called'); };

describe('snapshot shape', () => {
	it('emptySnapshot carries every contract key, nulled', () => {
		const snap = emptySnapshot(SYNTH, null);
		expect(Object.keys(snap).sort()).toEqual([...SNAPSHOT_FIELDS].sort());
		expect(snap.address).toBe(SYNTH);
		for (const k of SNAPSHOT_FIELDS) {
			if (k !== 'address') expect(snap[k]).toBeNull();
		}
	});

	it('snapshotFromMarket maps every market field and keeps the full key set', () => {
		const snap = snapshotFromMarket(THREE, fullMarket);
		expect(Object.keys(snap).sort()).toEqual([...SNAPSHOT_FIELDS].sort());
		expect(snap).toMatchObject({
			address: THREE,
			chain: 'solana',
			symbol: 'THREE',
			name: 'three.ws',
			priceUsd: 0.0031,
			change24h: 4.2,
			marketCapUsd: 3_100_000,
			fdvUsd: 3_100_000,
			liquidityUsd: 250_000,
			volume24hUsd: 91_000,
			dexId: 'pumpswap',
		});
		expect(snap.pairCreatedAt).toBe(new Date(1750000000000).toISOString());
	});

	it('thin market data maps to explicit nulls, never omitted keys', () => {
		const snap = snapshotFromMarket(SYNTH, { mint: SYNTH, chain: 'solana' });
		expect(Object.keys(snap).sort()).toEqual([...SNAPSHOT_FIELDS].sort());
		expect(snap.priceUsd).toBeNull();
		expect(snap.fdvUsd).toBeNull();
		expect(snap.pairCreatedAt).toBeNull();
	});
});

describe('pump.fun + metadata merges', () => {
	it('mergePumpCoin fills gaps but never overwrites DexScreener values', () => {
		const snap = snapshotFromMarket(SYNTH, { ...fullMarket, mint: SYNTH });
		const merged = mergePumpCoin(snap, pumpCoin);
		expect(merged.symbol).toBe('THREE'); // market value wins
		expect(merged.marketCapUsd).toBe(3_100_000);
	});

	it('mergePumpCoin supplies identity, mcap, and a pump.fun url on an empty snapshot', () => {
		const merged = mergePumpCoin(emptySnapshot(SYNTH, null), pumpCoin);
		expect(merged.symbol).toBe('SYNTH');
		expect(merged.name).toBe('synthetic sample');
		expect(merged.marketCapUsd).toBe(42_000);
		expect(merged.url).toBe(`https://pump.fun/coin/${SYNTH}`);
		expect(merged.chain).toBe('solana');
	});

	it('isBareMeta detects the unresolved placeholder and mergeMeta discards it', () => {
		const bare = { mint: SYNTH, symbol: SYNTH.slice(0, 6), name: SYNTH.slice(0, 6), decimals: null };
		expect(isBareMeta(bare)).toBe(true);
		expect(isBareMeta(undefined)).toBe(true);
		expect(isBareMeta({ mint: SYNTH, symbol: 'REAL', name: 'Real Token', decimals: 6 })).toBe(false);

		const snap = mergeMeta(emptySnapshot(SYNTH, 'solana'), bare);
		expect(snap.symbol).toBeNull();
		const enriched = mergeMeta(emptySnapshot(SYNTH, 'solana'), { mint: SYNTH, symbol: 'REAL', name: 'Real Token', decimals: 6 });
		expect(enriched.symbol).toBe('REAL');
	});
});

describe('composeTokenSnapshot — chain inference + source selection', () => {
	it('Solana address with a full DEX read → ok from dexscreener only, no pump call', async () => {
		const r = await composeTokenSnapshot({ address: THREE }, {
			fetchMarket: async () => fullMarket,
			fetchPump: never,
			fetchMeta: never,
		});
		expect(r.status).toBe('ok');
		expect(r.sources).toEqual(['dexscreener']);
		expect(r.snapshot.chain).toBe('solana');
		expect(r.note).toBeUndefined();
	});

	it('EVM address never consults pump.fun or Solana metadata', async () => {
		const r = await composeTokenSnapshot({ address: EVM }, {
			fetchMarket: async () => ({ ...fullMarket, mint: EVM, chain: 'base', dex: 'uniswap' }),
			fetchPump: never,
			fetchMeta: never,
		});
		expect(r.status).toBe('ok');
		expect(r.snapshot.chain).toBe('base');
	});

	it('passes the chain filter through to the market reader', async () => {
		let seen = null;
		await composeTokenSnapshot({ address: EVM, chain: 'bsc' }, {
			fetchMarket: async (_a, opts) => { seen = opts.chain; return { ...fullMarket, mint: EVM, chain: 'bsc' }; },
			fetchPump: never,
			fetchMeta: never,
		});
		expect(seen).toBe('bsc');
	});
});

describe('composeTokenSnapshot — degradation states', () => {
	it('DexScreener down + pump.fun ok → 200-shaped partial with note (never blocked)', async () => {
		const r = await composeTokenSnapshot({ address: SYNTH }, {
			fetchMarket: async () => { throw new Error('timeout'); },
			fetchPump: async () => ({ kind: 'ok', coin: pumpCoin }),
			fetchMeta: never,
		});
		expect(r.status).toBe('ok');
		expect(r.sources).toEqual(['pumpfun']);
		expect(r.snapshot.symbol).toBe('SYNTH');
		expect(r.snapshot.marketCapUsd).toBe(42_000);
		expect(r.snapshot.priceUsd).toBeNull();
		expect(r.note).toMatch(/dexscreener unavailable/);
	});

	it('no key, no pair: keyless pump fields still resolve while meta stays bare', async () => {
		// Simulates a deployment without HELIUS_API_KEY — getMetadataForMints
		// returns only the bare placeholder, which must be discarded, while the
		// keyless pump.fun read still supplies real identity.
		const r = await composeTokenSnapshot({ address: SYNTH }, {
			fetchMarket: async () => null,
			fetchPump: async () => ({ kind: 'ok', coin: pumpCoin }),
			fetchMeta: async () => new Map([[SYNTH, { mint: SYNTH, symbol: SYNTH.slice(0, 6), name: SYNTH.slice(0, 6), decimals: null }]]),
		});
		expect(r.status).toBe('ok');
		expect(r.sources).toEqual(['pumpfun']);
		expect(r.snapshot.name).toBe('synthetic sample');
	});

	it('non-pump SPL mint resolves identity via real Helius metadata', async () => {
		const r = await composeTokenSnapshot({ address: SYNTH }, {
			fetchMarket: async () => null,
			fetchPump: async () => ({ kind: 'not_found' }),
			fetchMeta: async () => new Map([[SYNTH, { mint: SYNTH, symbol: 'REAL', name: 'Real Token', decimals: 6 }]]),
		});
		expect(r.status).toBe('ok');
		expect(r.sources).toEqual(['helius']);
		expect(r.snapshot.symbol).toBe('REAL');
		expect(r.snapshot.priceUsd).toBeNull();
	});

	it('all sources answered, none know the address → not_found', async () => {
		const r = await composeTokenSnapshot({ address: SYNTH }, {
			fetchMarket: async () => null,
			fetchPump: async () => ({ kind: 'not_found' }),
			fetchMeta: async () => new Map(),
		});
		expect(r.status).toBe('not_found');
	});

	it('every source down → upstream_down, never a false not-found', async () => {
		const r = await composeTokenSnapshot({ address: SYNTH }, {
			fetchMarket: async () => { throw new Error('down'); },
			fetchPump: async () => ({ kind: 'upstream_down' }),
			fetchMeta: async () => new Map(),
		});
		expect(r.status).toBe('upstream_down');
	});

	it('EVM address, DexScreener down → upstream_down (no Solana fallbacks to consult)', async () => {
		const r = await composeTokenSnapshot({ address: EVM }, {
			fetchMarket: async () => { throw new Error('down'); },
			fetchPump: never,
			fetchMeta: never,
		});
		expect(r.status).toBe('upstream_down');
	});
});

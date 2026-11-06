import { describe, it, expect } from 'vitest';

import {
	windowToSec,
	rankTokens,
	mergeAndRank,
	mapDexRow,
	mapGmgnRow,
	toOutputRow,
	composeTrending,
	WEIGHTS,
	SPIKE_RATIO_CAP,
} from '../api/_lib/crypto-trending.js';

// Synthetic mints only — never a real third-party mint in fixtures (CLAUDE.md).
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const M2 = 'THREEsynthetic1111111111111111111111111111A';
const M3 = 'THREEsynthetic2222222222222222222222222222B';

describe('windowToSec', () => {
	it('maps known windows', () => {
		expect(windowToSec('5m')).toBe(300);
		expect(windowToSec('1h')).toBe(3600);
		expect(windowToSec('24h')).toBe(86400);
	});
	it('falls back to 1h for unknown/garbage', () => {
		expect(windowToSec('bogus')).toBe(3600);
		expect(windowToSec(undefined)).toBe(3600);
	});
});

describe('rankTokens — ranking order', () => {
	it('ranks higher combined momentum first and scores 0–100', () => {
		const ranked = rankTokens([
			{ mint: M2, volumeUsd: 100, buyPressure: 0.5, changePct: 0 }, // low
			{ mint: THREE, volumeUsd: 1000, buyPressure: 0.9, changePct: 40 }, // high
			{ mint: M3, volumeUsd: 400, buyPressure: 0.6, changePct: 10 }, // mid
		]);
		expect(ranked.map((t) => t.mint)).toEqual([THREE, M3, M2]);
		for (const t of ranked) {
			expect(t.score).toBeGreaterThanOrEqual(0);
			expect(t.score).toBeLessThanOrEqual(100);
		}
		expect(ranked[0].score).toBeGreaterThan(ranked[2].score);
	});

	it('does not penalize a token missing buy pressure / change (present-weight renorm)', () => {
		// Two tokens, identical volume-share leader, one with only volume present.
		const ranked = rankTokens([
			{ mint: THREE, volumeUsd: 1000, buyPressure: null, changePct: null },
			{ mint: M2, volumeUsd: 10, buyPressure: 0.5, changePct: 0 },
		]);
		const three = ranked.find((t) => t.mint === THREE);
		// Volume-only leader: full volShare (1.0) + saturated spike → high score,
		// scored purely on the features it has rather than dragged to zero.
		expect(three.score).toBeGreaterThan(80);
	});

	it('returns [] for empty/invalid input', () => {
		expect(rankTokens([])).toEqual([]);
		expect(rankTokens(null)).toEqual([]);
	});

	it('buy pressure lifts an otherwise-tied token', () => {
		const [a, b] = rankTokens([
			{ mint: THREE, volumeUsd: 500, buyPressure: 0.95, changePct: 0 },
			{ mint: M2, volumeUsd: 500, buyPressure: 0.2, changePct: 0 },
		]);
		expect(a.mint).toBe(THREE);
		expect(a.score).toBeGreaterThan(b.score);
	});
});

describe('mergeAndRank — dedupe + limit cap', () => {
	it('dedupes by mint keeping the higher score, regardless of set order', () => {
		const setA = [{ mint: THREE, volumeUsd: 100, score: 40 }];
		const setB = [{ mint: THREE, volumeUsd: 100, score: 90 }];
		const merged = mergeAndRank([setA, setB], 10);
		expect(merged).toHaveLength(1);
		expect(merged[0].score).toBe(90);
	});

	it('caps output to the limit', () => {
		const set = Array.from({ length: 60 }, (_, i) => ({
			mint: `mint${i}`,
			volumeUsd: i,
			score: i,
		}));
		expect(mergeAndRank([set], 50)).toHaveLength(50);
		expect(mergeAndRank([set], 5)).toHaveLength(5);
		// Highest score first after the cap.
		expect(mergeAndRank([set], 5)[0].score).toBe(59);
	});

	it('drops rows without a mint', () => {
		const merged = mergeAndRank([[{ volumeUsd: 1, score: 99 }, { mint: THREE, score: 10 }]], 10);
		expect(merged).toHaveLength(1);
		expect(merged[0].mint).toBe(THREE);
	});
});

describe('mapDexRow — window → change mapping + buy pressure', () => {
	const row = {
		address: THREE,
		symbol: 'THREE',
		name: 'three.ws',
		market_cap: 412000,
		volume: 18450,
		price_change_1h: 5,
		price_change_24h: 42,
		txns_h1_buys: 75,
		txns_h1_sells: 25,
	};
	it('uses 1h change for 5m/1h and 24h change for 24h', () => {
		expect(mapDexRow(row, '1h').changePct).toBe(5);
		expect(mapDexRow(row, '5m').changePct).toBe(5);
		expect(mapDexRow(row, '24h').changePct).toBe(42);
	});
	it('derives buy pressure from h1 txn counts', () => {
		expect(mapDexRow(row, '1h').buyPressure).toBeCloseTo(0.75);
	});
	it('null buy pressure when no txn flow', () => {
		expect(mapDexRow({ ...row, txns_h1_buys: null, txns_h1_sells: null }, '1h').buyPressure).toBeNull();
	});
});

describe('mapGmgnRow — guarded parsing', () => {
	it('rejects rows without a valid address', () => {
		expect(mapGmgnRow({ symbol: 'X' }, '1h')).toBeNull();
		expect(mapGmgnRow({ address: 'short' }, '1h')).toBeNull();
	});
	it('maps smart-money buy/sell into buy pressure', () => {
		const t = mapGmgnRow({ address: M2, symbol: 'S', smart_buy_24h: 8, smart_sell_24h: 2 }, '1h');
		expect(t.mint).toBe(M2);
		expect(t.buyPressure).toBeCloseTo(0.8);
	});
});

describe('toOutputRow — public shape', () => {
	it('emits exactly the documented fields, nulling missing ones', () => {
		const row = toOutputRow({ mint: THREE, score: 50, volumeUsd: 10 });
		expect(row).toEqual({
			mint: THREE,
			symbol: null,
			name: null,
			marketCapUsd: null,
			volumeUsd: 10,
			change: null,
			score: 50,
			url: null,
		});
	});
});

describe('composeTrending — source filter, states', () => {
	const pumpRows = [{ mint: THREE, symbol: 'THREE', volumeUsd: 1000, score: 90, changePct: 5 }];
	const dexRows = [{ mint: M2, symbol: 'DEX', volumeUsd: 500, score: 70, changePct: 2 }];
	const gmgnRows = [{ mint: M3, symbol: 'GM', volumeUsd: 200, score: 40, changePct: 1 }];

	it("source='pumpfun' only calls pump.fun", async () => {
		let dexCalled = false;
		const out = await composeTrending({
			window: '1h',
			limit: 20,
			source: 'pumpfun',
			nowMs: 1_750_000_000_000,
			deps: {
				pumpfun: async () => pumpRows,
				dexscreener: async () => {
					dexCalled = true;
					return dexRows;
				},
				gmgn: async () => gmgnRows,
			},
		});
		expect(dexCalled).toBe(false);
		expect(out.sources).toEqual(['pumpfun']);
		expect(out.tokens.map((t) => t.mint)).toEqual([THREE]);
		expect(out.count).toBe(1);
		expect(out.window).toBe('1h');
	});

	it("source='all' fuses every contributing source, ranked desc", async () => {
		const out = await composeTrending({
			window: '1h',
			limit: 20,
			source: 'all',
			nowMs: 1_750_000_000_000,
			deps: {
				pumpfun: async () => pumpRows,
				dexscreener: async () => dexRows,
				gmgn: async () => gmgnRows,
			},
		});
		expect(out.sources.sort()).toEqual(['dexscreener', 'gmgn', 'pumpfun']);
		expect(out.tokens.map((t) => t.score)).toEqual([90, 70, 40]);
	});

	it('respects the limit cap after merge', async () => {
		const out = await composeTrending({
			window: '1h',
			limit: 2,
			source: 'all',
			nowMs: 1_750_000_000_000,
			deps: {
				pumpfun: async () => pumpRows,
				dexscreener: async () => dexRows,
				gmgn: async () => gmgnRows,
			},
		});
		expect(out.tokens).toHaveLength(2);
		expect(out.tokens.map((t) => t.mint)).toEqual([THREE, M2]);
	});

	it('all sources down → 200-shaped empty result with a note, never throws', async () => {
		const out = await composeTrending({
			window: '1h',
			limit: 20,
			source: 'all',
			nowMs: 1_750_000_000_000,
			deps: {
				pumpfun: async () => [],
				dexscreener: async () => {
					throw new Error('dex down');
				},
				gmgn: async () => [],
			},
		});
		expect(out.count).toBe(0);
		expect(out.tokens).toEqual([]);
		expect(out.sources).toEqual([]);
		expect(out.note).toMatch(/unavailable/i);
	});

	it('partial data notes which source was down', async () => {
		const out = await composeTrending({
			window: '24h',
			limit: 20,
			source: 'all',
			nowMs: 1_750_000_000_000,
			deps: {
				pumpfun: async () => pumpRows,
				dexscreener: async () => [],
				gmgn: async () => [],
			},
		});
		expect(out.sources).toEqual(['pumpfun']);
		expect(out.note).toMatch(/dexscreener/);
		expect(out.note).toMatch(/gmgn/);
	});
});

describe('ranking weights are a coherent unit split', () => {
	it('weights sum to 1', () => {
		const sum = WEIGHTS.volume + WEIGHTS.buyDom + WEIGHTS.spike + WEIGHTS.change;
		expect(sum).toBeCloseTo(1);
		expect(SPIKE_RATIO_CAP).toBeGreaterThan(0);
	});
});

/**
 * Unit tests for the pump_trending score engine (pump-trending-score.js)
 * and the extractSignal shape used by the autonomous registry entry
 * `crypto-intel-pump-trending` (USE-047).
 *
 * Pure helpers (scorePressure, buildPumpTrendingSignal) are tested without
 * any network calls. extractSignal is exercised against a real payload
 * produced by buildPumpTrendingSignal to prove the registry entry correctly
 * lifts the actionable fields into oracle_intel_signals.
 */

import { describe, it, expect } from 'vitest';
import {
	scorePressure,
	buildPumpTrendingSignal,
	WHALE_SOL_THRESHOLD,
} from '../../api/_lib/x402/pump-trending-score.js';

// Mirror the inline extractSignal from the autonomous registry entry for
// crypto-intel-pump-trending (id: 'crypto-intel-pump-trending').
// Any change to extractSignal in autonomous-registry.js must be reflected here.
function extractSignal(r) {
	return {
		topic: 'pump_trending',
		signal: r?.signal ?? null,
		headline: r?.headline ?? null,
		confidence: r?.confidence ?? null,
		buy_pressure: r?.buy_pressure ?? null,
		total_volume_sol: r?.total_volume_sol ?? null,
		whale_buy_count: r?.whale_buy_count ?? 0,
		top_mint: r?.top_mint ?? null,
		trending_mints: Array.isArray(r?.trending_mints) ? r.trending_mints.slice(0, 5) : [],
		whale_buys: Array.isArray(r?.whale_buys) ? r.whale_buys.slice(0, 5) : [],
	};
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMint(i) {
	return 'M'.repeat(32) + String(i).padStart(12, '0');
}

function makeCoin(i) {
	return {
		mint: makeMint(i),
		symbol: `TOK${i}`,
		name: `Token ${i}`,
		market_cap_usd: 1_000_000 * (10 - i),
		market_cap_sol: 10_000 * (10 - i),
		rank: i + 1,
		complete: false,
	};
}

function makeTrade({ type = 'buy', amountSol = 1 } = {}) {
	return { type, amountSol, amountUsd: amountSol * 150, userAddress: 'TRADER' };
}

// ── scorePressure ─────────────────────────────────────────────────────────────

describe('scorePressure', () => {
	it('counts buys and sells correctly', () => {
		const coinTrades = [
			{
				mint: makeMint(0),
				trades: [makeTrade({ type: 'buy' }), makeTrade({ type: 'sell' }), makeTrade({ type: 'buy' })],
			},
		];
		const s = scorePressure(coinTrades);
		expect(s.totalBuys).toBe(2);
		expect(s.totalSells).toBe(1);
		expect(s.buyPressure).toBeCloseTo(2 / 3);
	});

	it('detects whale buys at or above the threshold', () => {
		const mint = makeMint(0);
		const coinTrades = [
			{
				mint,
				trades: [
					makeTrade({ type: 'buy', amountSol: WHALE_SOL_THRESHOLD }),
					makeTrade({ type: 'buy', amountSol: WHALE_SOL_THRESHOLD - 0.1 }),
					makeTrade({ type: 'buy', amountSol: WHALE_SOL_THRESHOLD + 10 }),
				],
			},
		];
		const s = scorePressure(coinTrades);
		expect(s.whaleBuys).toHaveLength(2);
		expect(s.whaleBuys.every((w) => w.mint === mint)).toBe(true);
		expect(s.whaleBuys.every((w) => w.sol_amount >= WHALE_SOL_THRESHOLD)).toBe(true);
	});

	it('does not count sells as whale buys', () => {
		const coinTrades = [
			{
				mint: makeMint(0),
				trades: [makeTrade({ type: 'sell', amountSol: WHALE_SOL_THRESHOLD + 100 })],
			},
		];
		const s = scorePressure(coinTrades);
		expect(s.whaleBuys).toHaveLength(0);
		expect(s.totalBuys).toBe(0);
	});

	it('handles empty trade lists without throwing', () => {
		const s = scorePressure([{ mint: makeMint(0), trades: [] }]);
		expect(s.buyPressure).toBe(0.5);
		expect(s.totalVolumeSol).toBe(0);
		expect(s.whaleBuys).toHaveLength(0);
	});

	it('sums volume across multiple coins', () => {
		const coinTrades = [
			{ mint: makeMint(0), trades: [makeTrade({ type: 'buy', amountSol: 3 })] },
			{ mint: makeMint(1), trades: [makeTrade({ type: 'buy', amountSol: 7 })] },
		];
		const s = scorePressure(coinTrades);
		expect(s.totalVolumeSol).toBeCloseTo(10);
		expect(s.totalBuys).toBe(2);
	});
});

// ── buildPumpTrendingSignal ───────────────────────────────────────────────────

describe('buildPumpTrendingSignal', () => {
	const COINS = Array.from({ length: 10 }, (_, i) => makeCoin(i));

	it('returns bullish signal when buy pressure >= 65%', () => {
		const score = { totalBuys: 13, totalSells: 7, buyPressure: 0.65, totalVolumeSol: 20, whaleBuys: [] };
		const r = buildPumpTrendingSignal(COINS, score);
		expect(r.signal).toBe('bullish');
		expect(r.topic).toBe('pump_trending');
		expect(r.confidence).toBeGreaterThan(0.55);
	});

	it('returns bearish signal when buy pressure <= 40%', () => {
		const score = { totalBuys: 4, totalSells: 6, buyPressure: 0.40, totalVolumeSol: 10, whaleBuys: [] };
		const r = buildPumpTrendingSignal(COINS, score);
		expect(r.signal).toBe('bearish');
	});

	it('returns neutral signal for balanced flow', () => {
		const score = { totalBuys: 10, totalSells: 10, buyPressure: 0.50, totalVolumeSol: 10, whaleBuys: [] };
		const r = buildPumpTrendingSignal(COINS, score);
		expect(r.signal).toBe('neutral');
	});

	it('includes trending_mints (up to 10), top_mint, and whale_buys', () => {
		const whale = { mint: makeMint(0), sol_amount: 10, usd_amount: 1500, trader: 'WHALE' };
		const score = { totalBuys: 8, totalSells: 2, buyPressure: 0.8, totalVolumeSol: 50, whaleBuys: [whale] };
		const r = buildPumpTrendingSignal(COINS, score);
		expect(r.trending_mints).toHaveLength(10);
		expect(r.top_mint).toBe(COINS[0].mint);
		expect(r.whale_buys).toHaveLength(1);
		expect(r.whale_buy_count).toBe(1);
		expect(r.buy_pressure).toBeCloseTo(0.8);
		expect(r.total_volume_sol).toBeCloseTo(50);
	});

	it('caps confidence at 0.92 regardless of buy pressure extremity', () => {
		const score = { totalBuys: 100, totalSells: 0, buyPressure: 1.0, totalVolumeSol: 100, whaleBuys: [] };
		const r = buildPumpTrendingSignal(COINS, score);
		expect(r.confidence).toBeLessThanOrEqual(0.92);
	});

	it('includes ts as an ISO date string', () => {
		const score = { totalBuys: 5, totalSells: 5, buyPressure: 0.5, totalVolumeSol: 0, whaleBuys: [] };
		const r = buildPumpTrendingSignal(COINS, score);
		expect(typeof r.ts).toBe('string');
		expect(() => new Date(r.ts)).not.toThrow();
	});
});

// ── extractSignal (registry entry shape) ────────────────────────────────────

describe('extractSignal — pump_trending registry entry', () => {
	const COINS = Array.from({ length: 12 }, (_, i) => makeCoin(i));
	const BULLISH_SCORE = {
		totalBuys: 14, totalSells: 6, buyPressure: 0.7,
		totalVolumeSol: 42, whaleBuys: [
			{ mint: makeMint(0), sol_amount: 8, usd_amount: 1200, trader: 'W1' },
			{ mint: makeMint(1), sol_amount: 6, usd_amount: 900,  trader: 'W2' },
			{ mint: makeMint(2), sol_amount: 5, usd_amount: 750,  trader: 'W3' },
			{ mint: makeMint(3), sol_amount: 5, usd_amount: 750,  trader: 'W4' },
			{ mint: makeMint(4), sol_amount: 7, usd_amount: 1050, trader: 'W5' },
			{ mint: makeMint(5), sol_amount: 9, usd_amount: 1350, trader: 'W6' }, // 6 whales total
		],
	};

	it('extracts all required oracle signal fields from a real payload', () => {
		const payload = buildPumpTrendingSignal(COINS, BULLISH_SCORE);
		const sig = extractSignal(payload);

		expect(sig.topic).toBe('pump_trending');
		expect(['bullish', 'bearish', 'neutral']).toContain(sig.signal);
		expect(typeof sig.headline).toBe('string');
		expect(sig.confidence).toBeGreaterThan(0);
		expect(sig.confidence).toBeLessThanOrEqual(1);
		expect(typeof sig.buy_pressure).toBe('number');
		expect(typeof sig.total_volume_sol).toBe('number');
		expect(typeof sig.whale_buy_count).toBe('number');
		expect(typeof sig.top_mint).toBe('string');
	});

	it('caps trending_mints at 5 even when the payload has 10', () => {
		const payload = buildPumpTrendingSignal(COINS, BULLISH_SCORE);
		expect(payload.trending_mints).toHaveLength(10); // raw payload has 10
		const sig = extractSignal(payload);
		expect(sig.trending_mints).toHaveLength(5); // registry caps at 5
	});

	it('caps whale_buys at 5 even when the payload has 6', () => {
		const payload = buildPumpTrendingSignal(COINS, BULLISH_SCORE);
		expect(payload.whale_buys).toHaveLength(6); // raw payload kept all 6 (≤10)
		const sig = extractSignal(payload);
		expect(sig.whale_buys).toHaveLength(5); // registry caps at 5
	});

	it('returns zero whale_buy_count and empty arrays on a null response', () => {
		const sig = extractSignal(null);
		expect(sig.topic).toBe('pump_trending');
		expect(sig.signal).toBeNull();
		expect(sig.headline).toBeNull();
		expect(sig.confidence).toBeNull();
		expect(sig.buy_pressure).toBeNull();
		expect(sig.total_volume_sol).toBeNull();
		expect(sig.whale_buy_count).toBe(0);
		expect(sig.top_mint).toBeNull();
		expect(sig.trending_mints).toEqual([]);
		expect(sig.whale_buys).toEqual([]);
	});

	it('returns zero whale_buy_count when payload has none', () => {
		const score = { totalBuys: 5, totalSells: 5, buyPressure: 0.5, totalVolumeSol: 5, whaleBuys: [] };
		const payload = buildPumpTrendingSignal(COINS.slice(0, 5), score);
		const sig = extractSignal(payload);
		expect(sig.whale_buy_count).toBe(0);
		expect(sig.whale_buys).toHaveLength(0);
	});

	it('trending_mints entries have mint, symbol, name, market_cap_usd, rank fields', () => {
		const score = { totalBuys: 7, totalSells: 3, buyPressure: 0.7, totalVolumeSol: 10, whaleBuys: [] };
		const payload = buildPumpTrendingSignal(COINS, score);
		const sig = extractSignal(payload);
		for (const m of sig.trending_mints) {
			expect(typeof m.mint).toBe('string');
			expect(typeof m.symbol).toBe('string');
			expect(typeof m.name).toBe('string');
			expect(typeof m.market_cap_usd).toBe('number');
			expect(typeof m.rank).toBe('number');
		}
	});
});

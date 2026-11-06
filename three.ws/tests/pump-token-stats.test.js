import { describe, it, expect } from 'vitest';
import { normalizeTrade, windowStats, holderStats } from '../api/pump/token-stats.js';

// The neutral fact sheet on /launches/<mint>. A wrong window boundary or a
// bonding curve counted as a holder would publish a false number about
// someone's coin, so the arithmetic is pinned here.

const NOW = 1_800_000_000;
const trade = (ago, side, usd, price, user = `w${ago}`) =>
	normalizeTrade({
		timestamp: new Date((NOW - ago) * 1000).toISOString(),
		type: side,
		amountUsd: String(usd),
		amountSol: '0.1',
		priceUsd: String(price),
		userAddress: user,
	});

describe('normalizeTrade', () => {
	it('drops rows without a side or timestamp', () => {
		expect(normalizeTrade({ type: 'buy' })).toBeNull();
		expect(normalizeTrade({ timestamp: new Date().toISOString(), type: 'swap' })).toBeNull();
	});
});

describe('windowStats', () => {
	const trades = [
		trade(7200, 'buy', 100, 1.0, 'a'),
		trade(1800, 'buy', 50, 1.2, 'b'),
		trade(600, 'sell', 20, 1.1, 'a'),
		trade(60, 'buy', 10, 1.5, 'c'),
	];

	it('counts buys, sells, volume, and net buy per window', () => {
		const w = windowStats(trades, { now: NOW });
		expect(w['5m']).toMatchObject({ buys: 1, sells: 0, volume_usd: 10, net_buy_usd: 10, traders: 1 });
		expect(w['1h']).toMatchObject({ buys: 2, sells: 1, buy_usd: 60, sell_usd: 20, net_buy_usd: 40, traders: 3 });
		expect(w['6h']).toMatchObject({ buys: 3, sells: 1, volume_usd: 180, traders: 3 });
	});

	it('measures price change from the last trade before the window opened', () => {
		const w = windowStats(trades, { now: NOW });
		expect(w['1h'].price_change_pct).toBeCloseTo(50);
		expect(w['5m'].price_change_pct).toBeCloseTo((1.5 / 1.1 - 1) * 100);
	});

	it('reads a quiet window as zero change, not a missing value', () => {
		const w = windowStats([trade(3000, 'buy', 5, 2)], { now: NOW });
		expect(w['5m']).toMatchObject({ buys: 0, volume_usd: 0, price_change_pct: 0 });
	});

	it('flags windows that reach past the fetched history as partial', () => {
		const w = windowStats(trades, { now: NOW, coveredFrom: NOW - 7200 });
		expect(w['1h'].partial).toBe(false);
		expect(w['6h'].partial).toBe(true);
		expect(w['24h'].partial).toBe(true);
	});
});

describe('holderStats', () => {
	const supply = 1_000_000_000_000_000n;
	const pct = (p) => (supply * BigInt(Math.round(p * 1000))) / 100_000n;
	const holders = [
		{ wallet: 'CURVE', units: pct(70) },
		{ wallet: 'whale', units: pct(10) },
		{ wallet: 'dev', units: pct(5) },
		{ wallet: 'early', units: pct(3) },
		...Array.from({ length: 12 }, (_, i) => ({ wallet: `h${i}`, units: pct(1) })),
	];

	it('leaves the bonding curve out of the holder ranking', () => {
		const h = holderStats(holders, { supply, creator: 'dev', curve: 'CURVE', pool: null, earlyBuyers: null });
		expect(h.count).toBe(15);
		expect(h.top1_pct).toBeCloseTo(0.1);
		expect(h.curve_pct).toBeCloseTo(0.7);
		expect(h.top10_pct).toBeCloseTo(0.25);
		expect(h.dev_pct).toBeCloseTo(0.05);
		expect(h.top[1]).toMatchObject({ wallet: 'dev', is_dev: true });
		expect(h.early_buyers).toBeNull();
		expect(h.early_buyers_pct).toBeNull();
	});

	it('sums what early buyers still hold, excluding the creator', () => {
		const h = holderStats(holders, {
			supply,
			creator: 'dev',
			curve: 'CURVE',
			pool: null,
			earlyBuyers: new Set(['early', 'dev', 'gone']),
		});
		expect(h.early_buyers).toBe(3);
		expect(h.early_buyers_pct).toBeCloseTo(0.03);
	});

	it('reports the top of the book but no count from a largest-accounts-only set', () => {
		const top = holders.slice(0, 5).filter((h) => h.wallet !== 'dev');
		const h = holderStats(top, {
			supply,
			creator: 'dev',
			curve: 'CURVE',
			pool: null,
			earlyBuyers: new Set(['early']),
			complete: false,
		});
		expect(h.count).toBeNull();
		expect(h.top1_pct).toBeCloseTo(0.1);
		// The dev fell outside the largest accounts, so the share is unknown, not 0.
		expect(h.dev_pct).toBeNull();
		expect(h.early_buyers).toBeNull();
		expect(h.early_buyers_pct).toBeNull();
	});
});

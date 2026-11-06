import { describe, it, expect } from 'vitest';

import {
	classifyThreeSignal,
	usdToThreeTokens,
	insertThreeSignal,
	getThreeSignalHistory,
	THREE_DECIMALS,
} from '../api/_lib/x402/three-signal-store.js';

// A live three-intel response (DexScreener-backed shape).
const SAMPLE = {
	mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	symbol: 'THREE',
	price_usd: 0.003685,
	change_24h: 12.4,
	market_cap_usd: 3685000,
	liquidity_usd: 412000,
	volume_24h_usd: 1268079,
	signal: 'bullish',
	headline: 'THREE climbs +12.40% — moderate upside',
	rationale: 'THREE gained +12.40% over 24 h.',
	confidence: 0.86,
	ts: '2026-06-27T10:00:00Z',
};

// Minimal mock of the tagged-template `sql` client: records every query's text
// and interpolated values so we can assert on what the store wrote.
function mockSql() {
	const calls = [];
	const fn = (strings, ...values) => {
		calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
		return Promise.resolve([]);
	};
	fn.calls = calls;
	return fn;
}

describe('three-signal-store — classifyThreeSignal', () => {
	it('carries the full market shape through', () => {
		const v = classifyThreeSignal(SAMPLE);
		expect(v.mint).toBe(SAMPLE.mint);
		expect(v.symbol).toBe('THREE');
		expect(v.price_usd).toBe(0.003685);
		expect(v.change_24h).toBe(12.4);
		expect(v.market_cap_usd).toBe(3685000);
		expect(v.liquidity_usd).toBe(412000);
		expect(v.volume_24h_usd).toBe(1268079);
		expect(v.signal).toBe('bullish');
		expect(v.confidence).toBe(0.86);
		expect(v.ts).toBe('2026-06-27T10:00:00Z');
	});

	it('coerces string numerics and defaults symbol to THREE', () => {
		const v = classifyThreeSignal({ price_usd: '0.0042', change_24h: '-3.1' });
		expect(v.price_usd).toBeCloseTo(0.0042, 10);
		expect(v.change_24h).toBeCloseTo(-3.1, 10);
		expect(v.symbol).toBe('THREE');
	});

	it('degrades missing/garbage fields to null, never throws', () => {
		const v = classifyThreeSignal(null);
		expect(v.price_usd).toBeNull();
		expect(v.signal).toBeNull();
		expect(v.ts).toBeNull();
		const g = classifyThreeSignal({ price_usd: 'not-a-number' });
		expect(g.price_usd).toBeNull();
	});
});

describe('three-signal-store — usdToThreeTokens', () => {
	it('converts USD to $THREE tokens + atomics at the given price', () => {
		const r = usdToThreeTokens(1, 0.002);
		expect(r.tokens).toBe(500);
		expect(r.atomics).toBe(500 * 10 ** THREE_DECIMALS);
	});

	it('returns null for unusable prices (zero, negative, missing)', () => {
		expect(usdToThreeTokens(1, 0)).toBeNull();
		expect(usdToThreeTokens(1, -0.5)).toBeNull();
		expect(usdToThreeTokens(1, null)).toBeNull();
		expect(usdToThreeTokens(null, 0.002)).toBeNull();
	});
});

describe('three-signal-store — insertThreeSignal', () => {
	it('ensures schema then inserts the snapshot with run metadata', async () => {
		const sql = mockSql();
		await insertThreeSignal(sql, classifyThreeSignal(SAMPLE), { runId: 'run-1', source: 'x402-autonomous' });
		// ensure (table + index) may already be cached from a prior test → assert the
		// INSERT happened regardless, carrying our values.
		const insert = sql.calls.find((c) => /INSERT INTO three_market_signals/i.test(c.text));
		expect(insert).toBeTruthy();
		expect(insert.values).toContain(SAMPLE.mint);
		expect(insert.values).toContain(0.003685);
		expect(insert.values).toContain('run-1');
		expect(insert.values).toContain('x402-autonomous');
	});

	it('is a no-op without a sql client', async () => {
		await expect(insertThreeSignal(null, classifyThreeSignal(SAMPLE))).resolves.toBeUndefined();
	});
});

describe('three-signal-store — getThreeSignalHistory', () => {
	it('clamps the limit into [1, 500]', async () => {
		const sql = mockSql();
		await getThreeSignalHistory(sql, 9999);
		await getThreeSignalHistory(sql, -5);
		const limits = sql.calls.map((c) => c.values[c.values.length - 1]);
		expect(limits).toContain(500);
		expect(limits).toContain(1);
	});
});

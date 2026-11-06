import { describe, it, expect } from 'vitest';

import { getSelfRegistry } from '../api/_lib/x402/autonomous-registry.js';

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
	confidence: 0.86,
	ts: '2026-06-27T10:00:00Z',
};

function mockSql() {
	const calls = [];
	const fn = (strings, ...values) => {
		calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
		return Promise.resolve([]);
	};
	fn.calls = calls;
	return fn;
}

describe('autonomous registry — three-intel entry', () => {
	const entry = getSelfRegistry().find((e) => e.id === 'three-intel');

	it('exists, is enabled, GET, oracle pipeline, 15-min cooldown', () => {
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.method).toBe('GET');
		expect(entry.pipeline).toBe('oracle');
		expect(entry.cooldown_s).toBe(900);
		expect(entry.path).toBe('/api/x402/three-intel');
	});

	it('extractSignal tags topic=three and carries the market shape', () => {
		const sig = entry.extractSignal(SAMPLE);
		expect(sig.topic).toBe('three');
		expect(sig.price_usd).toBe(0.003685);
		expect(sig.signal).toBe('bullish');
	});

	it('storeValue persists a valid snapshot to the time series', async () => {
		const sql = mockSql();
		await entry.storeValue({ sql, responseBody: SAMPLE, signalData: null, runId: 'run-2' });
		const insert = sql.calls.find((c) => /INSERT INTO three_market_signals/i.test(c.text));
		expect(insert).toBeTruthy();
		expect(insert.values).toContain('run-2');
	});

	it('storeValue skips an empty/failed snapshot (no price → no row)', async () => {
		const sql = mockSql();
		await entry.storeValue({ sql, responseBody: { signal: 'neutral' }, signalData: null, runId: 'run-3' });
		const insert = sql.calls.find((c) => /INSERT INTO three_market_signals/i.test(c.text));
		expect(insert).toBeFalsy();
	});

	it('storeValue never throws when sql is missing', async () => {
		await expect(entry.storeValue({ sql: null, responseBody: SAMPLE })).resolves.toBeUndefined();
	});
});

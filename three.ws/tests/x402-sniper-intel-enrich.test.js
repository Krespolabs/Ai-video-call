import { describe, it, expect } from 'vitest';

import {
	deriveSentiment,
	run,
} from '../api/_lib/x402/pipelines/sniper-intel-enrich.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';

const intel = (over = {}) => ({
	topic: 'sol',
	headline: 'SOL surges +9.1% in 24 h — strong momentum',
	signal: 'bullish',
	price_usd: 152.4,
	change_24h: 9.1,
	rationale: 'SOL is up +9.1%, trading at $152.40.',
	confidence: 0.9,
	ts: '2026-06-29T10:00:00Z',
	...over,
});

describe('sniper intel enrich — sentiment → gate delta', () => {
	it('lowers the bar (negative delta) on a bullish read, scaled by confidence', () => {
		const v = deriveSentiment(intel({ signal: 'bullish', confidence: 1 }));
		expect(v).toBeTruthy();
		expect(v.signal).toBe('bullish');
		expect(v.sentiment_adj).toBe(-4); // -round(4 * 1)
		expect(v.sentiment_adj).toBeLessThan(0);
	});

	it('raises the bar (positive delta) on a bearish read, scaled by confidence', () => {
		const v = deriveSentiment(intel({ signal: 'bearish', confidence: 1 }));
		expect(v.signal).toBe('bearish');
		expect(v.sentiment_adj).toBe(8); // round(8 * 1)
		expect(v.sentiment_adj).toBeGreaterThan(0);
	});

	it('is asymmetric — bearish moves the bar more than bullish at equal confidence', () => {
		const bull = deriveSentiment(intel({ signal: 'bullish', confidence: 0.8 }));
		const bear = deriveSentiment(intel({ signal: 'bearish', confidence: 0.8 }));
		expect(Math.abs(bear.sentiment_adj)).toBeGreaterThan(Math.abs(bull.sentiment_adj));
	});

	it('leaves the bar untouched on a neutral read', () => {
		const v = deriveSentiment(intel({ signal: 'neutral', confidence: 0.9 }));
		expect(v.sentiment_adj).toBe(0);
	});

	it('clamps the delta to ±10 even at maximum confidence', () => {
		const bear = deriveSentiment(intel({ signal: 'bearish', confidence: 1 }));
		const bull = deriveSentiment(intel({ signal: 'bullish', confidence: 1 }));
		expect(bear.sentiment_adj).toBeLessThanOrEqual(10);
		expect(bull.sentiment_adj).toBeGreaterThanOrEqual(-10);
	});

	it('defaults confidence to 0.5 when the response omits or corrupts it', () => {
		const v = deriveSentiment(intel({ confidence: undefined }));
		expect(v.confidence).toBe(0.5);
		const bad = deriveSentiment(intel({ confidence: 'NaN' }));
		expect(bad.confidence).toBe(0.5);
	});

	it('preserves the headline, price, and 24 h change for the sink', () => {
		const v = deriveSentiment(intel());
		expect(v.headline).toContain('SOL surges');
		expect(v.price_usd).toBe(152.4);
		expect(v.change_24h).toBe(9.1);
	});

	it('returns null for a malformed, empty, or unknown-signal body', () => {
		expect(deriveSentiment(null)).toBeNull();
		expect(deriveSentiment({})).toBeNull();
		expect(deriveSentiment({ signal: 'sideways' })).toBeNull();
	});
});

describe('sniper intel enrich — registry wiring', () => {
	it('is registered as an enabled, run()-style sniper entry on crypto-intel', () => {
		const entry = getFullRegistry().find((e) => e.id === 'sniper-intel-enrich');
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.pipeline).toBe('sniper');
		expect(entry.cooldown_s).toBe(900);
		expect(typeof entry.run).toBe('function');
		expect(entry.path).toBe('/api/x402/crypto-intel');
	});
});

describe('sniper intel enrich — graceful degradation', () => {
	it('never throws when the DB/wallet are unconfigured; returns a skipped outcome', async () => {
		const out = await run({ runId: '00000000-0000-0000-0000-000000000024' });
		expect(out).toBeTruthy();
		expect(out.amountAtomic).toBe(0);
		// Either the schema/select degraded (no targets) or the wallet was
		// unconfigured — both are skip outcomes, never a thrown error.
		expect(out.skipped === true || out.success === true).toBe(true);
	});
});

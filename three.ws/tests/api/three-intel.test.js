// Tests for /api/x402/three-intel — the $THREE Town Oracle endpoint.
//
// Pure-logic only — we exercise the exported helpers (buildSignal, BAZAAR)
// rather than the paidEndpoint HTTP wrapper, keeping tests off the network
// while covering everything the wire format and the kiosk depend on.
//
// Coverage:
//   • buildSignal thresholds: bullish (>5, >1), bearish (<-5, <-1), neutral
//   • turnover (volume/liquidity) shapes the rationale's flow line
//   • confidence stays in [0.4, 0.93] and grows with |change|
//   • The bazaar block advertises the output fields the kiosk renders

import { describe, it, expect } from 'vitest';
import { buildSignal, BAZAAR } from '../../api/x402/three-intel.js';

const base = { price_usd: 0.0036, volume_24h_usd: 500_000, liquidity_usd: 400_000 };

describe('buildSignal — thresholds', () => {
	it('strong pump reads bullish with a surge headline', () => {
		const s = buildSignal({ ...base, change_24h: 12.4 });
		expect(s.signal).toBe('bullish');
		expect(s.headline).toContain('surges');
		expect(s.headline).toContain('+12.40%');
	});

	it('mild gain reads bullish with a climb headline', () => {
		const s = buildSignal({ ...base, change_24h: 2.1 });
		expect(s.signal).toBe('bullish');
		expect(s.headline).toContain('climbs');
	});

	it('strong dump reads bearish', () => {
		const s = buildSignal({ ...base, change_24h: -9.8 });
		expect(s.signal).toBe('bearish');
		expect(s.headline).toContain('drops');
		expect(s.headline).toContain('9.80%');
	});

	it('mild loss reads bearish with a slip headline', () => {
		const s = buildSignal({ ...base, change_24h: -1.7 });
		expect(s.signal).toBe('bearish');
		expect(s.headline).toContain('slips');
	});

	it('flat tape reads neutral and quotes the price', () => {
		const s = buildSignal({ ...base, change_24h: 0.3 });
		expect(s.signal).toBe('neutral');
		expect(s.headline).toContain('consolidating');
		expect(s.headline).toContain('$0.003600');
	});
});

describe('buildSignal — flow line from volume/liquidity turnover', () => {
	it('high turnover (>3×) reads as high conviction', () => {
		const s = buildSignal({ ...base, change_24h: 6, volume_24h_usd: 2_000_000, liquidity_usd: 400_000 });
		expect(s.rationale).toContain('high conviction');
	});

	it('moderate turnover (1–3×) reads as real participation', () => {
		const s = buildSignal({ ...base, change_24h: 6, volume_24h_usd: 600_000, liquidity_usd: 400_000 });
		expect(s.rationale).toContain('participation is real');
	});

	it('light turnover (<1×) reads as limited backing', () => {
		const s = buildSignal({ ...base, change_24h: 6, volume_24h_usd: 100_000, liquidity_usd: 400_000 });
		expect(s.rationale).toContain('limited backing');
	});

	it('missing flow data degrades to a thin-data caveat', () => {
		const s = buildSignal({ ...base, change_24h: 6, volume_24h_usd: null, liquidity_usd: null });
		expect(s.rationale).toContain('Flow data is thin');
	});
});

describe('buildSignal — confidence', () => {
	it('grows with |change| and stays within [0.64, 0.93]', () => {
		const calm = buildSignal({ ...base, change_24h: 0.2 });
		const wild = buildSignal({ ...base, change_24h: 40 });
		expect(calm.confidence).toBeGreaterThanOrEqual(0.64);
		expect(wild.confidence).toBeLessThanOrEqual(0.93);
		expect(wild.confidence).toBeGreaterThan(calm.confidence);
	});
});

describe('BAZAAR — discovery block', () => {
	it('advertises every field the kiosk renders', () => {
		const props = BAZAAR.schema?.properties?.output?.properties
			?? BAZAAR.output?.example ?? {};
		for (const key of ['signal', 'headline', 'price_usd', 'change_24h', 'market_cap_usd']) {
			expect(BAZAAR.output.example).toHaveProperty(key);
		}
		expect(props).toBeTruthy();
		expect(BAZAAR.output.example.mint).toBe('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
	});
});

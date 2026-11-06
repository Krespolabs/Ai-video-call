import { describe, it, expect } from 'vitest';
import { renderCard } from '../api/pump/launch-og.js';

// Guards the /launches/<mint> social card:
//   1. the live market cap was read from a `market_cap_in_usd` key pump.fun
//      does not emit, so MKT CAP never appeared for a coin still on the curve;
//   2. the card stays neutral: raw launch counts only, never a score, a grade,
//      or an engine label such as "rugged" on someone's coin;
//   3. a fatal DB read had to degrade to a branded card, never a 5xx.

const MINT = 'THREEsynthetic1111111111111111111111111111';

function baseCard(overrides = {}) {
	return {
		name: 'Synthetic Launch',
		symbol: 'SYN',
		logoBase64: null,
		category: 'meme',
		isThreeWsLaunch: true,
		intel: null,
		outcome: null,
		liveMcap: null,
		...overrides,
	};
}

describe('launch-og renderCard', () => {
	it('renders a well-formed 1200x630 SVG for the minimum viable card', () => {
		const svg = renderCard(MINT, baseCard());
		expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(svg).toContain('width="1200" height="630"');
		expect(svg).toContain('Synthetic Launch');
		expect(svg).toContain('$SYN');
		// No enrichment supplied, so the optional blocks stay out of the card.
		expect(svg).not.toContain('MKT CAP');
		expect(svg).not.toContain('UNIQUE BUYERS');
	});

	it('draws the live market cap a coin on the curve reports', () => {
		const svg = renderCard(MINT, baseCard({ liveMcap: 2_337_959 }));
		expect(svg).toContain('MKT CAP');
		expect(svg).toContain('$2.3M');
	});

	it('falls back to the recorded outcome market cap once a coin has an outcome', () => {
		const svg = renderCard(MINT, baseCard({
			liveMcap: null,
			outcome: { graduated: true, ath_market_cap_usd: 84_000 },
		}));
		expect(svg).toContain('GRADUATED');
		expect(svg).toContain('$84K');
	});

	it('shows launch activity as raw counts', () => {
		const svg = renderCard(MINT, baseCard({
			intel: { unique_buyers: 29, buy_count: 41, sell_count: 12 },
		}));
		expect(svg).toContain('UNIQUE BUYERS');
		expect(svg).toContain('>29<');
		expect(svg).toContain('BUYS / SELLS AT LAUNCH');
		expect(svg).toContain('>41 / 12<');
	});

	it('never puts a score or an engine verdict on the card', () => {
		const svg = renderCard(MINT, baseCard({
			intel: { quality_score: 12, organic_score: 0.05, bundle_score: 0.61, unique_buyers: 3 },
			outcome: { rugged: true, outcome: 'rugged', last_market_cap_usd: 4_000 },
		}));
		for (const banned of ['SCORE', 'ORGANIC', 'BUNDLE', 'RUGGED']) expect(svg).not.toContain(banned);
		expect(svg).toContain('LIVE');
	});

	it('escapes coin metadata so a hostile name cannot inject SVG markup', () => {
		const svg = renderCard(MINT, baseCard({ name: '<script>alert(1)</script>', symbol: 'a"b' }));
		expect(svg).not.toContain('<script>');
		expect(svg).toContain('&lt;script&gt;');
		expect(svg).toContain('&quot;');
	});

	it('still renders a branded card when every enrichment read failed', () => {
		const svg = renderCard(MINT, {
			name: '', symbol: '', logoBase64: null, category: '',
			isThreeWsLaunch: false, intel: null, outcome: null, liveMcap: null,
		});
		expect(svg).toContain('Unknown coin');
		expect(svg).toContain('THREE.WS');
		expect(svg).not.toContain('undefined');
		expect(svg).not.toContain('NaN');
	});
});

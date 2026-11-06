// Pins the shared SQL win definition across every oracle accuracy endpoint.
//
// A "win" is graduation, or a ≥2× ATH on a coin that did NOT rug. The
// "not rugged" clause is load-bearing: bundled pump-and-dumps routinely spike
// 2× from first-seen mcap before collapsing, so the old
// `graduated or ath_multiple >= 2` definition counted exit-liquidity wicks as
// wins and inflated the platform's headline win rate with the very launches
// the engine exists to flag. Any endpoint that reintroduces the naive
// definition fails here instead of silently lying on the dashboard.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FILES = [
	'api/oracle/stats.js',
	'api/oracle/backtest.js',
	'api/oracle/wins.js',
];

const NAIVE_WIN = /(?:graduated\s+or\s+o\.ath_multiple\s*>=\s*2|o\.ath_multiple\s*>=\s*2\s+or\s+o?\.?graduated)(?![^)]*rugged)/i;
const HONEST_WIN = /o\.ath_multiple\s*>=\s*2\s+and\s+not\s+coalesce\(o\.rugged,\s*false\)/i;

describe('oracle win definition excludes rugged pump-and-dumps', () => {
	for (const rel of FILES) {
		const src = readFileSync(join(ROOT, rel), 'utf8');

		it(`${rel} uses the rug-aware win definition at least once`, () => {
			expect(HONEST_WIN.test(src)).toBe(true);
		});

		it(`${rel} has no naive ath>=2 win clause without the rugged guard`, () => {
			expect(src).not.toMatch(NAIVE_WIN);
		});
	}
});

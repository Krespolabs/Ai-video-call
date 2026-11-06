// Regression guard for a production 500: the oracle endpoints used to join
// `pump_coin_outcomes o` on `o.mint = c.mint AND o.network = c.network`, but
// `pump_coin_outcomes` has no `network` column (its primary key is `mint`
// alone, which already references pump_coin_intel(mint) 1:1). That broke every
// /api/oracle/wins, /backtest, and /stats request with
// `column o.network does not exist`. The network filter is enforced upstream by
// `where c.network = $1` on oracle_conviction, so the outcomes join must key on
// mint only. This test pins that — any reintroduction of `o.network` in a
// pump_coin_outcomes join fails here instead of in production.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FILES = [
	'api/oracle/wins.js',
	'api/oracle/backtest.js',
	'api/oracle/stats.js',
];

describe('pump_coin_outcomes join keys on mint only', () => {
	for (const rel of FILES) {
		it(`${rel} does not join pump_coin_outcomes on a nonexistent network column`, () => {
			const src = readFileSync(join(ROOT, rel), 'utf8');
			// Find every "join pump_coin_outcomes <alias> on ..." clause up to the
			// line break and assert none of them reference "<alias>.network".
			const joins = src.match(/join\s+pump_coin_outcomes\s+(\w+)\s+on[^\n]*/gi) || [];
			expect(joins.length).toBeGreaterThan(0);
			for (const clause of joins) {
				const alias = clause.match(/pump_coin_outcomes\s+(\w+)/i)[1];
				expect(clause).not.toMatch(new RegExp(`\\b${alias}\\.network\\b`));
			}
		});
	}
});

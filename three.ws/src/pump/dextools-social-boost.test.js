// The Social Boost record is hand-kept, so these guard the mistakes a hand edit
// makes: a win out of order, a receipt that points somewhere other than
// DEXTools' own pages, or a pair URL that drifts from the pair constant.

import { describe, it, expect } from 'vitest';
import {
	THREE_DEXTOOLS_PAIR,
	DEXTOOLS_PAIR_URL,
	SOCIAL_BOOST_WINS,
	DEXTOOLS_HOLDING,
	socialBoostSummary,
} from './dextools-social-boost.js';

describe('DEXTools Social Boost record', () => {
	it('links the pair explorer for the $THREE pair', () => {
		expect(THREE_DEXTOOLS_PAIR).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
		expect(DEXTOOLS_PAIR_URL).toBe(`https://www.dextools.io/app/solana/pair-explorer/${THREE_DEXTOOLS_PAIR}`);
	});

	it('lists wins newest first, each with a positive prize and a real day', () => {
		const dates = SOCIAL_BOOST_WINS.map((w) => w.date);
		expect(dates).toEqual([...dates].sort().reverse());
		for (const w of SOCIAL_BOOST_WINS) {
			expect(['daily', 'weekly']).toContain(w.period);
			expect(w.prizeUsd).toBeGreaterThan(0);
			expect(new Date(`${w.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(w.date);
		}
	});

	it('gives every win a public receipt, and a daily win its own DEXTools winner page', () => {
		for (const w of SOCIAL_BOOST_WINS) {
			const url = new URL(w.receipt);
			expect(url.protocol).toBe('https:');
			if (w.period === 'daily') {
				expect(w.receipt.startsWith(DEXTOOLS_PAIR_URL)).toBe(true);
				expect(url.searchParams.get('social-boost')).toBe(`daily-${w.date}`);
			}
		}
	});

	it('summarises the record', () => {
		expect(socialBoostSummary()).toEqual({ count: 3, totalUsd: 11382, largestUsd: 5543 });
		expect(socialBoostSummary([])).toEqual({ count: 0, totalUsd: 0, largestUsd: 0 });
		expect(DEXTOOLS_HOLDING.tokens).toBeGreaterThan(0);
	});
});

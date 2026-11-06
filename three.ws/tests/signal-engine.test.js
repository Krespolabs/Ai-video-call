/**
 * Signal marketplace engine — pure logic tests.
 *
 * Money-adjacent + reputation-adjacent: pin the outcome classification, the
 * conviction/sizing math (a runaway "size_multiple" can never push a subscriber's
 * order past its cap), and the confidence-regressed feed-edge score (a thin feed
 * riding one lucky call can never out-rank a deep, consistent one).
 */

import { describe, it, expect } from 'vitest';
// Import from the PURE core (no DB / network / SDK chain) so these logic tests
// load even when the delivery half's native deps aren't resolvable. signal-engine.js
// re-exports every one of these, so this is the same surface the product uses.
import {
	classifyOutcome, computeSizeMultiple, computeConviction, subscriberOrderSol,
	feedEdgeScore, rankFeeds, FEED_SORTS,
} from '../api/_lib/signal-engine-core.js';

describe('classifyOutcome', () => {
	it('classifies clear wins and losses by sign', () => {
		expect(classifyOutcome(42)).toBe('win');
		expect(classifyOutcome(-30)).toBe('loss');
	});
	it('treats a near-zero result as flat, not a win', () => {
		expect(classifyOutcome(0)).toBe('flat');
		expect(classifyOutcome(0.5)).toBe('flat');
		expect(classifyOutcome(-0.9)).toBe('flat');
		expect(classifyOutcome(1.01)).toBe('win');
	});
	it('returns null for missing / non-finite input', () => {
		expect(classifyOutcome(null)).toBeNull();
		expect(classifyOutcome(undefined)).toBeNull();
		expect(classifyOutcome(NaN)).toBeNull();
	});
});

describe('computeSizeMultiple', () => {
	it('1.0 when the entry equals the trader\'s typical size', () => {
		expect(computeSizeMultiple(0.3, 0.3)).toBe(1);
	});
	it('scales linearly with the bet size', () => {
		expect(computeSizeMultiple(0.9, 0.3)).toBe(3);
		expect(computeSizeMultiple(0.15, 0.3)).toBe(0.5);
	});
	it('defaults to 1 when there is no reference or no entry', () => {
		expect(computeSizeMultiple(0.3, 0)).toBe(1);
		expect(computeSizeMultiple(0, 0.3)).toBe(1);
	});
});

describe('computeConviction', () => {
	it('a typical-size bet is mid conviction, a 3x+ bet is max', () => {
		expect(computeConviction(1)).toBeCloseTo(0.333, 2);
		expect(computeConviction(3)).toBe(1);
		expect(computeConviction(5)).toBe(1); // clamped
	});
	it('is 0 for a non-positive multiple', () => {
		expect(computeConviction(0)).toBe(0);
		expect(computeConviction(-2)).toBe(0);
	});
});

describe('subscriberOrderSol', () => {
	it('sizes base × multiple × scaling', () => {
		expect(subscriberOrderSol({ baseSol: 0.05, sizeMultiple: 2, sizeScaling: 1, maxPerTradeSol: 1 })).toBe(0.1);
		expect(subscriberOrderSol({ baseSol: 0.05, sizeMultiple: 2, sizeScaling: 3, maxPerTradeSol: 1 })).toBe(0.3);
	});
	it('hard-caps at max_per_trade no matter how convicted the signal', () => {
		// 0.05 × 10 × 5 = 2.5 SOL, but the cap is 0.25.
		expect(subscriberOrderSol({ baseSol: 0.05, sizeMultiple: 10, sizeScaling: 5, maxPerTradeSol: 0.25 })).toBe(0.25);
	});
	it('returns 0 (skip) for a dust-sized order', () => {
		expect(subscriberOrderSol({ baseSol: 0.001, sizeMultiple: 1, sizeScaling: 1, maxPerTradeSol: 1 })).toBe(0);
	});
});

describe('feedEdgeScore — confidence regression', () => {
	it('a thin feed cannot reach the score its raw stats imply', () => {
		// One perfect signal: hit-rate 1.0, +80% ROI — but only 1 closed signal.
		const thin = feedEdgeScore({ closedSignals: 1, winningSignals: 1, avgRealizedPct: 80, publisherScore: 50 });
		// A deep feed with identical edge over 30 closed signals.
		const deep = feedEdgeScore({ closedSignals: 30, winningSignals: 30, avgRealizedPct: 80, publisherScore: 50 });
		expect(deep).toBeGreaterThan(thin);
		expect(thin).toBeLessThan(75); // regressed toward the blended neutral
		expect(deep).toBeGreaterThan(85);
	});
	it('a strongly-verified publisher lifts a thin feed via the prior', () => {
		const lowPrior = feedEdgeScore({ closedSignals: 2, winningSignals: 2, avgRealizedPct: 40, publisherScore: 20 });
		const highPrior = feedEdgeScore({ closedSignals: 2, winningSignals: 2, avgRealizedPct: 40, publisherScore: 95 });
		expect(highPrior).toBeGreaterThan(lowPrior);
	});
	it('losers drag the score below a coin-flip feed', () => {
		const winning = feedEdgeScore({ closedSignals: 20, winningSignals: 16, avgRealizedPct: 25, publisherScore: 60 });
		const losing = feedEdgeScore({ closedSignals: 20, winningSignals: 4, avgRealizedPct: -20, publisherScore: 60 });
		expect(winning).toBeGreaterThan(losing);
	});
	it('is bounded to 0..100', () => {
		const hi = feedEdgeScore({ closedSignals: 100, winningSignals: 100, avgRealizedPct: 9999, publisherScore: 100 });
		const lo = feedEdgeScore({ closedSignals: 100, winningSignals: 0, avgRealizedPct: -9999, publisherScore: 0 });
		expect(hi).toBeLessThanOrEqual(100);
		expect(lo).toBeGreaterThanOrEqual(0);
	});
});

describe('rankFeeds', () => {
	const feeds = [
		{ slug: 'a', edge_score: 40, closed_signals: 5, avg_realized_pct: 10, hit_rate: 0.5, subscribers: 9, created_at: '2026-01-01' },
		{ slug: 'b', edge_score: 80, closed_signals: 30, avg_realized_pct: 35, hit_rate: 0.7, subscribers: 2, created_at: '2026-02-01' },
		{ slug: 'c', edge_score: 60, closed_signals: 12, avg_realized_pct: 60, hit_rate: 0.6, subscribers: 5, created_at: '2026-03-01' },
	];
	it('ranks by proven edge by default and assigns 1-based ranks', () => {
		const ranked = rankFeeds(feeds, 'edge');
		expect(ranked.map((f) => f.slug)).toEqual(['b', 'c', 'a']);
		expect(ranked.map((f) => f.rank)).toEqual([1, 2, 3]);
	});
	it('ranks by ROI, hit-rate, and subscribers when asked', () => {
		expect(rankFeeds(feeds, 'roi').map((f) => f.slug)).toEqual(['c', 'b', 'a']);
		expect(rankFeeds(feeds, 'hitrate').map((f) => f.slug)).toEqual(['b', 'c', 'a']);
		expect(rankFeeds(feeds, 'subscribers').map((f) => f.slug)).toEqual(['a', 'c', 'b']);
	});
	it('never ranks by follower count under the default sort', () => {
		// Feed "a" has the most subscribers but the worst edge — it stays last.
		expect(rankFeeds(feeds, 'edge')[2].slug).toBe('a');
	});
	it('exposes its sort vocabulary', () => {
		expect(FEED_SORTS.has('edge')).toBe(true);
		expect(FEED_SORTS.has('subscribers')).toBe(true);
	});
});

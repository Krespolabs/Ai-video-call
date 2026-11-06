// Fork-royalty fairness math — the guardrails the whole feature rests on:
// opt-in, per-creator + total caps, depth decay, and majority-always-to-forker.
// Pure functions only (no DB / no chain), so the invariants are pinned exactly.

import { describe, it, expect } from 'vitest';
import {
	resolveSchedule,
	splitIncome,
	clampCreatorBps,
	getRoyaltyConfig,
	ROYALTY_PER_CREATOR_CAP_BPS,
	ROYALTY_TOTAL_CAP_BPS,
	MIN_FORKER_KEEP_BPS,
	ROYALTY_MIN_PAYOUT_LAMPORTS,
} from '../api/_lib/fork-royalties.js';

const anc = (depth, set_bps, id = `a${depth}`, extra = {}) => ({
	depth,
	ancestor_agent_id: id,
	ancestor_wallet: `wallet-${id}`,
	set_bps,
	...extra,
});

describe('clampCreatorBps', () => {
	it('clamps to the per-creator cap and floors negatives/garbage to 0', () => {
		expect(clampCreatorBps(500)).toBe(500);
		expect(clampCreatorBps(99_999)).toBe(ROYALTY_PER_CREATOR_CAP_BPS);
		expect(clampCreatorBps(-10)).toBe(0);
		expect(clampCreatorBps('abc')).toBe(0);
		expect(clampCreatorBps(undefined)).toBe(0);
	});
});

describe('getRoyaltyConfig', () => {
	it('defaults to no royalty (forks are free) with both income types eligible', () => {
		expect(getRoyaltyConfig(null)).toEqual({ bps: 0, eligible: { tips: true, stream: true }, set_at: null });
		expect(getRoyaltyConfig({})).toEqual({ bps: 0, eligible: { tips: true, stream: true }, set_at: null });
	});
	it('reads + clamps a configured rate and honors eligibility opt-outs', () => {
		const cfg = getRoyaltyConfig({ fork_royalty: { bps: 5000, eligible: { tips: true, stream: false }, set_at: 'x' } });
		expect(cfg.bps).toBe(ROYALTY_PER_CREATOR_CAP_BPS); // clamped down from 50%
		expect(cfg.eligible).toEqual({ tips: true, stream: false });
		expect(cfg.set_at).toBe('x');
	});
});

describe('resolveSchedule — decay', () => {
	it('immediate parent earns its set rate; each generation halves', () => {
		const r = resolveSchedule([anc(1, 800), anc(2, 800), anc(3, 800)]);
		const bps = r.entries.map((e) => e.bps);
		expect(bps).toEqual([800, 400, 200]); // 800 · {1, .5, .25}
		expect(r.total_bps).toBe(1400);
		expect(r.keep_bps).toBe(8600);
	});

	it('drops ancestors that opted out (0 bps) and those that decay below 1bp', () => {
		const r = resolveSchedule([anc(1, 0), anc(2, 1)]); // depth2 → round(0.5) = 1 stays; depth with 0 drops
		expect(r.entries.map((e) => e.ancestor_agent_id)).toEqual(['a2']);
	});
});

describe('resolveSchedule — caps + majority invariant', () => {
	it('never lets the forker keep less than the floor, even with many greedy ancestors', () => {
		const greedy = Array.from({ length: 8 }, (_, i) => anc(i + 1, ROYALTY_PER_CREATOR_CAP_BPS, `g${i}`));
		const r = resolveSchedule(greedy);
		expect(r.total_bps).toBeLessThanOrEqual(ROYALTY_TOTAL_CAP_BPS);
		expect(r.keep_bps).toBeGreaterThanOrEqual(MIN_FORKER_KEEP_BPS);
		// Scaled shares still sum exactly to the capped total.
		expect(r.entries.reduce((s, e) => s + e.bps, 0)).toBe(r.total_bps);
	});

	it('scales proportionally when the decayed sum exceeds the total cap', () => {
		// Two direct-ish ancestors at max: 1000 + 500 = 1500 < 2000 → unscaled.
		const under = resolveSchedule([anc(1, 1000), anc(2, 1000)]);
		expect(under.total_bps).toBe(1500);
		// Force over-cap: three at full depth-1-equivalent via low depths.
		const over = resolveSchedule([anc(1, 1000), anc(1, 1000, 'x'), anc(1, 1000, 'y')]);
		expect(over.total_bps).toBe(ROYALTY_TOTAL_CAP_BPS);
		expect(over.keep_bps).toBe(MIN_FORKER_KEEP_BPS);
	});

	it('empty lineage → no royalty, forker keeps everything', () => {
		const r = resolveSchedule([]);
		expect(r.total_bps).toBe(0);
		expect(r.keep_bps).toBe(10000);
		expect(r.entries).toEqual([]);
	});
});

describe('splitIncome', () => {
	const schedule = resolveSchedule([anc(1, 1000), anc(2, 1000)]); // 1000 + 500 = 1500 bps
	const ONE_SOL = 1_000_000_000n;

	it('splits a SOL tip by bps and leaves the forker the majority', () => {
		const { splits, upstream_lamports, keep_lamports } = splitIncome(ONE_SOL, schedule, 'tips');
		expect(splits[0].amount_lamports).toBe((ONE_SOL * 1000n) / 10000n); // 0.10 SOL
		expect(splits[1].amount_lamports).toBe((ONE_SOL * 500n) / 10000n); // 0.05 SOL
		expect(upstream_lamports).toBe((ONE_SOL * 1500n) / 10000n);
		expect(keep_lamports).toBe(ONE_SOL - upstream_lamports);
		expect(keep_lamports > upstream_lamports).toBe(true); // majority to forker
	});

	it('skips dust shares rather than paying a fee-negative transfer', () => {
		// Tiny income → every share lands below the dust floor.
		const tiny = ROYALTY_MIN_PAYOUT_LAMPORTS; // 0.00002 SOL split 10%/5% → both sub-dust
		const { splits, upstream_lamports } = splitIncome(tiny, schedule, 'tips');
		expect(splits.every((s) => s.skipped)).toBe(true);
		expect(upstream_lamports).toBe(0n);
	});

	it('pays nothing to an ancestor that excluded this income type', () => {
		const s2 = resolveSchedule([anc(1, 1000, 'a1', { eligible: { tips: false, stream: true } })]);
		const { splits, upstream_lamports } = splitIncome(ONE_SOL, s2, 'tips');
		expect(splits[0].skipped).toBe(true);
		expect(splits[0].reason).toBe('ineligible_income_type');
		expect(upstream_lamports).toBe(0n);
		// …but the same ancestor IS paid on stream income.
		const stream = splitIncome(ONE_SOL, s2, 'stream');
		expect(stream.upstream_lamports).toBe((ONE_SOL * 1000n) / 10000n);
	});
});

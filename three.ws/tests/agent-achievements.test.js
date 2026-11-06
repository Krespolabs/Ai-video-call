// Unit tests for the agent achievements engine — api/_lib/agent-achievements.js.
//
// The engine is pure (no I/O): given an agent's real metrics it returns the
// earned + locked badge set. These tests pin the award thresholds, the
// graduation/migration detection, progress reporting, and the summary roll-up.

import { describe, it, expect } from 'vitest';

import {
	computeAchievements,
	deriveMetrics,
	isLaunchGraduated,
	ACHIEVEMENTS,
	TIER_RANK,
} from '../api/_lib/agent-achievements.js';

const NOW = Date.UTC(2026, 5, 29); // fixed clock for deterministic tenure/dates
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

const byId = (result, id) => result.achievements.find((a) => a.id === id);

describe('isLaunchGraduated', () => {
	it('treats complete === true as graduated', () => {
		expect(isLaunchGraduated({ complete: true })).toBe(true);
	});
	it('treats a recorded AMM pool as graduated even if complete lags', () => {
		expect(isLaunchGraduated({ complete: false, raydium_pool: 'pool111' })).toBe(true);
		expect(isLaunchGraduated({ pump_swap_pool: 'pool222' })).toBe(true);
	});
	it('treats a market cap past the graduation threshold as graduated', () => {
		expect(isLaunchGraduated({ usd_market_cap: 70_000 })).toBe(true);
		expect(isLaunchGraduated({ usd_market_cap: 50_000 })).toBe(false);
	});
	it('is false for null / empty / non-graduated coins', () => {
		expect(isLaunchGraduated(null)).toBe(false);
		expect(isLaunchGraduated({})).toBe(false);
		expect(isLaunchGraduated({ complete: false, usd_market_cap: 1234 })).toBe(false);
	});
});

describe('deriveMetrics', () => {
	it('rolls launches, graduations, peak mcap, supporters, burns, tenure', () => {
		const m = deriveMetrics({
			now: NOW,
			agentCreatedAt: daysAgo(200),
			launches: [
				{ network: 'mainnet', graduated: true, mcap: 120_000, created_at: daysAgo(100) },
				{ network: 'mainnet', graduated: false, mcap: 4_000, created_at: daysAgo(10) },
				{ network: 'devnet', graduated: false, mcap: 0, created_at: daysAgo(5) },
			],
			payments: { confirmed_payments: 12, unique_payers: 9 },
			burns: { runs: 2 },
			reputation: { rank: 3 },
		});
		expect(m.launchesTotal).toBe(3);
		expect(m.mainnetLaunches).toBe(2);
		expect(m.graduations).toBe(1);
		expect(m.topMcap).toBe(120_000);
		expect(m.uniquePayers).toBe(9);
		expect(m.burnRuns).toBe(2);
		expect(m.reputationRank).toBe(3);
		expect(Math.round(m.ageDays)).toBe(200);
	});

	it('defends against missing/garbage inputs', () => {
		const m = deriveMetrics({});
		expect(m.launchesTotal).toBe(0);
		expect(m.graduations).toBe(0);
		expect(m.topMcap).toBe(0);
		expect(m.ageDays).toBe(0);
	});
});

describe('computeAchievements — awards', () => {
	it('awards the graduate badge when a launch migrated (the headline signal)', () => {
		const result = computeAchievements({
			now: NOW,
			agentCreatedAt: daysAgo(45),
			launches: [{ network: 'mainnet', graduated: true, mcap: 80_000, created_at: daysAgo(40) }],
			payments: {},
			burns: {},
		});
		const grad = byId(result, 'graduate');
		expect(grad.earned).toBe(true);
		expect(grad.tier).toBe('gold');
		// earnedAt is pulled from the launch's real timestamp.
		expect(grad.earnedAt).toBe(daysAgo(40));
		// First launch + 30-day tenure also unlock here.
		expect(byId(result, 'trailblazer').earned).toBe(true);
		expect(byId(result, 'established').earned).toBe(true);
		// But not the harder migration / mcap / tenure tiers.
		expect(byId(result, 'migrator').earned).toBe(false);
		expect(byId(result, 'seven-figures').earned).toBe(false);
		expect(byId(result, 'veteran').earned).toBe(false);
	});

	it('awards seven-figures only past $1M peak market cap', () => {
		const justUnder = computeAchievements({
			now: NOW, launches: [{ network: 'mainnet', mcap: 999_000, graduated: true, created_at: daysAgo(1) }],
		});
		expect(byId(justUnder, 'seven-figures').earned).toBe(false);
		expect(byId(justUnder, 'six-figures').earned).toBe(true);

		const over = computeAchievements({
			now: NOW, launches: [{ network: 'mainnet', mcap: 2_500_000, graduated: true, created_at: daysAgo(1) }],
		});
		expect(byId(over, 'seven-figures').earned).toBe(true);
	});

	it('awards community tiers by distinct supporters', () => {
		const result = computeAchievements({ now: NOW, payments: { unique_payers: 12 } });
		expect(byId(result, 'first-supporter').earned).toBe(true);
		expect(byId(result, 'crowd-backed').earned).toBe(true);
		expect(byId(result, 'fan-favorite').earned).toBe(false);
	});

	it('awards reputation badges by tier rank', () => {
		const trusted = computeAchievements({ now: NOW, reputation: { rank: 3, tier: 'trusted', tierLabel: 'Trusted' } });
		expect(byId(trusted, 'trusted-operator').earned).toBe(true);
		expect(byId(trusted, 'elite-operator').earned).toBe(false);

		const elite = computeAchievements({ now: NOW, reputation: { rank: 4, tier: 'elite', tierLabel: 'Elite' } });
		expect(byId(elite, 'elite-operator').earned).toBe(true);
	});
});

describe('computeAchievements — progress + summary', () => {
	it('reports honest progress on a locked badge', () => {
		const result = computeAchievements({ now: NOW, payments: { unique_payers: 7 } });
		const crowd = byId(result, 'crowd-backed'); // target 10
		expect(crowd.earned).toBe(false);
		expect(crowd.progress.value).toBe(7);
		expect(crowd.progress.target).toBe(10);
		expect(crowd.progress.pct).toBeCloseTo(0.7, 5);
	});

	it('summarizes earned count, top tier, and headline stats', () => {
		const result = computeAchievements({
			now: NOW,
			agentCreatedAt: daysAgo(400),
			// 15 launches (clears the launch-count tiers); the peak crosses $1M and
			// all graduated (clears the migration tiers).
			launches: Array.from({ length: 15 }, (_, i) => ({
				network: 'mainnet',
				graduated: true,
				mcap: i === 0 ? 1_500_000 : 90_000,
				created_at: daysAgo(300 - i * 10),
			})),
			payments: { unique_payers: 60, confirmed_payments: 200 },
			burns: { runs: 11 },
			reputation: { rank: 4, tier: 'elite', tierLabel: 'Elite' },
		});
		expect(result.summary.graduations).toBe(15);
		expect(result.summary.topMcap).toBe(1_500_000);
		expect(result.summary.uniquePayers).toBe(60);
		expect(result.summary.reputationTier).toBe('Elite');
		// A maxed-out agent earns every achievement; top tier is legendary.
		expect(result.summary.earnedCount).toBe(ACHIEVEMENTS.length);
		expect(result.summary.total).toBe(ACHIEVEMENTS.length);
		expect(result.summary.topTier).toBe('legendary');
	});

	it('an empty agent earns nothing and has a null top tier', () => {
		const result = computeAchievements({ now: NOW });
		expect(result.earned).toHaveLength(0);
		expect(result.summary.earnedCount).toBe(0);
		expect(result.summary.topTier).toBe(null);
		// Every catalog entry is still present as a locked goal.
		expect(result.locked).toHaveLength(ACHIEVEMENTS.length);
	});
});

describe('catalog integrity', () => {
	it('has unique ids and known tiers', () => {
		const ids = ACHIEVEMENTS.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const a of ACHIEVEMENTS) {
			expect(TIER_RANK[a.tier]).toBeTypeOf('number');
			expect(a.threshold).toBeGreaterThan(0);
		}
	});
});

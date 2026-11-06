/**
 * Agent achievements engine — pure, deterministic, no I/O.
 * =======================================================
 *
 * Turns an agent's REAL platform record (coins launched, graduations/migrations,
 * peak market caps, supporters, burns, reputation, tenure) into a tiered set of
 * achievements. Kept side-effect-free so the formula is unit-testable and could
 * later back the OG card, the leaderboard, or a notification — the HTTP handler
 * (api/agents/_id/achievements.js) gathers the inputs and hands them here.
 *
 * Every threshold is grounded in something a holder can verify on-chain or in the
 * public feeds. Nothing here invents data: a missing/zeroed metric simply leaves
 * the relevant badge locked (with honest progress), never falsely awarded.
 */

// Tier ranking — drives the "highest tier earned" summary and the UI accents.
export const TIER_RANK = { bronze: 0, silver: 1, gold: 2, legendary: 3 };

// pump.fun bonding curves graduate (migrate to the AMM) around a ~$69k USD
// market cap; the same constant the coin-status widget uses for its gauge.
const GRADUATION_CAP_USD = 69_000;

const DAY_MS = 86_400_000;

/**
 * The achievement catalog. Each entry is awarded when `metric >= threshold`.
 * `metric` indexes into the derived metrics object below, so adding an award is
 * a one-line change. `earnedAtKind` tells the engine which real timeline to pull
 * the unlock timestamp from (best-effort; null when not knowable).
 *
 * `unit` shapes how the UI renders progress on a still-locked badge.
 */
export const ACHIEVEMENTS = [
	// ── Creating ──────────────────────────────────────────────────────────────
	{ id: 'trailblazer', group: 'Creator', tier: 'bronze', icon: '🚀',
		title: 'Trailblazer', description: 'Launched a coin on three.ws.',
		metric: 'launchesTotal', threshold: 1, unit: 'count', earnedAtKind: 'launch' },
	{ id: 'serial-creator', group: 'Creator', tier: 'silver', icon: '🏭',
		title: 'Serial Creator', description: 'Launched 5 coins through the platform.',
		metric: 'launchesTotal', threshold: 5, unit: 'count', earnedAtKind: 'launch' },
	{ id: 'launch-machine', group: 'Creator', tier: 'gold', icon: '⚙️',
		title: 'Launch Machine', description: 'Launched 15 coins — a true factory.',
		metric: 'launchesTotal', threshold: 15, unit: 'count', earnedAtKind: 'launch' },

	// ── Graduation / migration (the headline success signal) ────────────────────
	{ id: 'graduate', group: 'Migration', tier: 'gold', icon: '🎓',
		title: 'Graduate', description: 'Launched a coin that completed its bonding curve and migrated.',
		metric: 'graduations', threshold: 1, unit: 'count', earnedAtKind: 'graduation' },
	{ id: 'migrator', group: 'Migration', tier: 'legendary', icon: '🏆',
		title: 'Serial Migrator', description: 'Three launches graduated and migrated to the AMM.',
		metric: 'graduations', threshold: 3, unit: 'count', earnedAtKind: 'graduation' },

	// ── Market cap milestones ───────────────────────────────────────────────────
	{ id: 'six-figures', group: 'Market', tier: 'silver', icon: '💰',
		title: 'Six Figures', description: 'A launch crossed a $100K market cap.',
		metric: 'topMcap', threshold: 100_000, unit: 'usd' },
	{ id: 'seven-figures', group: 'Market', tier: 'legendary', icon: '💎',
		title: 'Seven Figures', description: 'A launch crossed a $1M market cap.',
		metric: 'topMcap', threshold: 1_000_000, unit: 'usd' },

	// ── Community / supporters ──────────────────────────────────────────────────
	{ id: 'first-supporter', group: 'Community', tier: 'bronze', icon: '🤝',
		title: 'First Supporter', description: 'Received a confirmed on-chain payment.',
		metric: 'uniquePayers', threshold: 1, unit: 'count' },
	{ id: 'crowd-backed', group: 'Community', tier: 'silver', icon: '👥',
		title: 'Crowd-Backed', description: '10 distinct wallets paid this agent.',
		metric: 'uniquePayers', threshold: 10, unit: 'count' },
	{ id: 'fan-favorite', group: 'Community', tier: 'gold', icon: '🌟',
		title: 'Fan Favorite', description: '50 distinct wallets paid this agent.',
		metric: 'uniquePayers', threshold: 50, unit: 'count' },

	// ── Tokenomics / burns ──────────────────────────────────────────────────────
	{ id: 'deflationary', group: 'Tokenomics', tier: 'silver', icon: '🔥',
		title: 'Deflationary', description: 'Ran a buyback-and-burn on a launch.',
		metric: 'burnRuns', threshold: 1, unit: 'count' },
	{ id: 'scorched-earth', group: 'Tokenomics', tier: 'gold', icon: '🌋',
		title: 'Scorched Earth', description: 'Completed 10 buyback-and-burn runs.',
		metric: 'burnRuns', threshold: 10, unit: 'count' },

	// ── Reputation ──────────────────────────────────────────────────────────────
	{ id: 'trusted-operator', group: 'Reputation', tier: 'gold', icon: '🛡️',
		title: 'Trusted Operator', description: 'Reached the Trusted reputation tier.',
		metric: 'reputationRank', threshold: 3, unit: 'rank' },
	{ id: 'elite-operator', group: 'Reputation', tier: 'legendary', icon: '👑',
		title: 'Elite Operator', description: 'Reached the Elite reputation tier.',
		metric: 'reputationRank', threshold: 4, unit: 'rank' },

	// ── Tenure ──────────────────────────────────────────────────────────────────
	{ id: 'established', group: 'Tenure', tier: 'bronze', icon: '📅',
		title: 'Established', description: 'Active on three.ws for 30 days.',
		metric: 'ageDays', threshold: 30, unit: 'days', earnedAtKind: 'tenure' },
	{ id: 'veteran', group: 'Tenure', tier: 'silver', icon: '🗓️',
		title: 'Veteran', description: 'Active on three.ws for 180 days.',
		metric: 'ageDays', threshold: 180, unit: 'days', earnedAtKind: 'tenure' },
];

function toMs(v) {
	if (v == null) return null;
	const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
	return Number.isFinite(t) ? t : null;
}

/**
 * Decide whether a single launch counts as graduated/migrated from its live
 * pump.fun coin object. `complete === true` is the authoritative migration flag;
 * a recorded AMM pool, or a market cap past the graduation threshold, are honest
 * fallbacks when the upstream `complete` flag lags the pool creation.
 */
export function isLaunchGraduated(coin) {
	if (!coin || typeof coin !== 'object') return false;
	if (coin.complete === true) return true;
	if (coin.raydium_pool || coin.pump_swap_pool || coin.amm_pool) return true;
	const mcap = Number(coin.usd_market_cap);
	return Number.isFinite(mcap) && mcap >= GRADUATION_CAP_USD;
}

/**
 * Derive the flat metrics object every achievement is scored against.
 * @param {object} ctx — see computeAchievements
 */
export function deriveMetrics(ctx = {}) {
	const launches = Array.isArray(ctx.launches) ? ctx.launches : [];
	const payments = ctx.payments || {};
	const burns = ctx.burns || {};
	const reputation = ctx.reputation || null;
	const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
	const agentCreatedMs = toMs(ctx.agentCreatedAt);

	const graduatedLaunches = launches.filter((l) => l && l.graduated);
	const topMcap = launches.reduce((max, l) => {
		const m = Number(l?.mcap);
		return Number.isFinite(m) && m > max ? m : max;
	}, 0);

	return {
		launchesTotal: launches.length,
		mainnetLaunches: launches.filter((l) => l && l.network !== 'devnet').length,
		graduations: graduatedLaunches.length,
		topMcap,
		uniquePayers: Number(payments.unique_payers) || 0,
		confirmedPayments: Number(payments.confirmed_payments) || 0,
		burnRuns: Number(burns.runs) || 0,
		reputationRank: reputation ? Number(reputation.rank) || 0 : 0,
		ageDays: agentCreatedMs != null ? Math.max(0, (now - agentCreatedMs) / DAY_MS) : 0,
	};
}

// Ascending-sorted launch timestamps (ms) for milestone unlock dates.
function ascendingLaunchTimes(launches, onlyGraduated = false) {
	return (launches || [])
		.filter((l) => l && (!onlyGraduated || l.graduated))
		.map((l) => toMs(l.created_at))
		.filter((t) => t != null)
		.sort((a, b) => a - b);
}

function resolveEarnedAt(entry, ctx, metrics) {
	const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
	switch (entry.earnedAtKind) {
		case 'launch': {
			const times = ascendingLaunchTimes(ctx.launches);
			const t = times[entry.threshold - 1];
			return t != null ? new Date(t).toISOString() : null;
		}
		case 'graduation': {
			const times = ascendingLaunchTimes(ctx.launches, true);
			const t = times[entry.threshold - 1];
			return t != null ? new Date(t).toISOString() : null;
		}
		case 'tenure': {
			const created = toMs(ctx.agentCreatedAt);
			if (created == null) return null;
			const at = created + entry.threshold * DAY_MS;
			return at <= now ? new Date(at).toISOString() : null;
		}
		default:
			return null;
	}
}

/**
 * Compute the full achievement set for an agent.
 *
 * @param {object} ctx
 * @param {string|number|Date} [ctx.agentCreatedAt] — agent_identities.created_at
 * @param {Array<{network?:string, created_at?:any, graduated?:boolean, mcap?:number}>} [ctx.launches]
 * @param {{confirmed_payments?:number, unique_payers?:number}} [ctx.payments]
 * @param {{runs?:number}} [ctx.burns]
 * @param {{rank?:number, tier?:string, tierLabel?:string, score?:number}|null} [ctx.reputation]
 * @param {number} [ctx.now] — epoch ms (injectable for deterministic tests)
 * @returns {{achievements: object[], earned: object[], locked: object[], summary: object}}
 */
export function computeAchievements(ctx = {}) {
	const metrics = deriveMetrics(ctx);

	const achievements = ACHIEVEMENTS.map((entry) => {
		const current = Number(metrics[entry.metric]) || 0;
		const earned = current >= entry.threshold;
		return {
			id: entry.id,
			group: entry.group,
			tier: entry.tier,
			icon: entry.icon,
			title: entry.title,
			description: entry.description,
			unit: entry.unit,
			earned,
			earnedAt: earned ? resolveEarnedAt(entry, ctx, metrics) : null,
			progress: {
				current: Math.min(current, entry.threshold),
				target: entry.threshold,
				// Raw value too — the UI shows "62 / 50" gracefully where earned.
				value: current,
				pct: entry.threshold > 0 ? Math.min(1, current / entry.threshold) : 1,
			},
		};
	});

	const earned = achievements.filter((a) => a.earned);
	const locked = achievements.filter((a) => !a.earned);
	const topTier = earned.reduce(
		(best, a) => (TIER_RANK[a.tier] > TIER_RANK[best] ? a.tier : best),
		earned.length ? 'bronze' : null,
	);

	return {
		achievements,
		earned,
		locked,
		summary: {
			earnedCount: earned.length,
			total: achievements.length,
			topTier,
			launches: metrics.launchesTotal,
			graduations: metrics.graduations,
			topMcap: metrics.topMcap,
			uniquePayers: metrics.uniquePayers,
			burnRuns: metrics.burnRuns,
			reputationTier: ctx.reputation?.tierLabel || ctx.reputation?.tier || null,
		},
	};
}

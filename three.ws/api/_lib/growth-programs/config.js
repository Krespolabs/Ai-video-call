// @ts-check
// Trading growth programs: the arm flags and caps for the three owner-gated
// levers of the pump.fun trading roadmap (917 sections 3.8, 12.15, 13.4).
//
//   big_win_x      posts notable live wins to @trythreews        (owner gate 2)
//   rug_softener   pays $THREE toward a first-timer's first rug  (owner gate 1)
//   early_leader   pays $THREE bonuses to the first N leaders    (owner gate 1)
//
// Every program ships DISARMED. The selection logic always runs on real data
// and is inspectable (GET /api/ops/growth-programs, the crons' dry-run output,
// scripts/growth-programs-report.mjs), but the side-effecting leg only runs
// when its flag is exactly "1" or "true". Anything else, including unset, a
// typo, or "yes", reads as off: a flag that moves money fails closed.
//
// Every numeric knob has a code ceiling. An env var can lower a cap, never
// raise it past the ceiling, so a fat-fingered "RUG_SOFTENER_DAILY_CAP_USD=10000"
// still pays at most the ceiling. Raising a ceiling is a code change, reviewed
// in git, which is the point.

/** Read a flag strictly. Only "1" and "true" arm; everything else is off. */
export function flagOn(name, env = process.env) {
	const v = String(env[name] ?? '').trim().toLowerCase();
	return v === '1' || v === 'true';
}

/**
 * A number from env, clamped into [min, ceiling], or the default when unset or
 * unparseable. The default itself is clamped too, so a default can never sit
 * above its own ceiling.
 */
export function boundedNumber(env, name, { def, min = 0, ceiling }) {
	const raw = env[name];
	const parsed = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
	const value = Number.isFinite(parsed) ? parsed : def;
	return Math.min(ceiling, Math.max(min, value));
}

/** Hard ceilings. Env can lower these, never raise them. */
export const CEILINGS = Object.freeze({
	bigWin: {
		dailyCap: 4, // posts per 24h from this lane
		accountDailyCap: 15, // posts per 24h across every automated lane on the account
		lookbackHours: 72,
	},
	rugSoftener: {
		reimbursePct: 50,
		maxPerClaimUsd: 100,
		dailyCapUsd: 500,
		claimWindowDays: 30,
	},
	earlyLeader: {
		slots: 50,
		bonusUsd: 250,
		weeklyCapUsd: 1000,
	},
});

/**
 * Resolve every program's configuration from the environment.
 * @param {Record<string, string|undefined>} [env]
 */
export function programConfig(env = process.env) {
	return {
		bigWinX: {
			flag: 'BIG_WIN_X_ENABLED',
			enabled: flagOn('BIG_WIN_X_ENABLED', env),
			// A "big win" is a live, closed, meaningfully sized trade that at least
			// doubled. A +200% on a 0.001 SOL test fill is not news, so size gates
			// sit beside the percentage.
			minPct: boundedNumber(env, 'BIG_WIN_X_MIN_PCT', { def: 100, min: 50, ceiling: 100_000 }),
			minEntrySol: boundedNumber(env, 'BIG_WIN_X_MIN_ENTRY_SOL', { def: 0.1, min: 0.01, ceiling: 1000 }),
			minPnlSol: boundedNumber(env, 'BIG_WIN_X_MIN_PNL_SOL', { def: 0.1, min: 0.01, ceiling: 1000 }),
			lookbackHours: boundedNumber(env, 'BIG_WIN_X_LOOKBACK_HOURS', { def: 24, min: 1, ceiling: CEILINGS.bigWin.lookbackHours }),
			dailyCap: Math.floor(boundedNumber(env, 'BIG_WIN_X_DAILY_CAP', { def: 2, min: 0, ceiling: CEILINGS.bigWin.dailyCap })),
			perAgentHours: boundedNumber(env, 'BIG_WIN_X_PER_AGENT_HOURS', { def: 24, min: 1, ceiling: 24 * 30 }),
			accountDailyCap: Math.floor(
				boundedNumber(env, 'BIG_WIN_X_ACCOUNT_DAILY_CAP', { def: 15, min: 0, ceiling: CEILINGS.bigWin.accountDailyCap }),
			),
		},
		rugSoftener: {
			flag: 'RUG_SOFTENER_ENABLED',
			enabled: flagOn('RUG_SOFTENER_ENABLED', env),
			reimbursePct: boundedNumber(env, 'RUG_SOFTENER_REIMBURSE_PCT', { def: 50, min: 1, ceiling: CEILINGS.rugSoftener.reimbursePct }),
			maxPerClaimUsd: boundedNumber(env, 'RUG_SOFTENER_MAX_PER_CLAIM_USD', { def: 25, min: 1, ceiling: CEILINGS.rugSoftener.maxPerClaimUsd }),
			dailyCapUsd: boundedNumber(env, 'RUG_SOFTENER_DAILY_CAP_USD', { def: 100, min: 0, ceiling: CEILINGS.rugSoftener.dailyCapUsd }),
			minLossSol: boundedNumber(env, 'RUG_SOFTENER_MIN_LOSS_SOL', { def: 0.02, min: 0.005, ceiling: 100 }),
			minEntrySol: boundedNumber(env, 'RUG_SOFTENER_MIN_ENTRY_SOL', { def: 0.05, min: 0.01, ceiling: 100 }),
			claimWindowDays: boundedNumber(env, 'RUG_SOFTENER_CLAIM_WINDOW_DAYS', { def: 14, min: 1, ceiling: CEILINGS.rugSoftener.claimWindowDays }),
			minAccountAgeHours: boundedNumber(env, 'RUG_SOFTENER_MIN_ACCOUNT_AGE_HOURS', { def: 24, min: 1, ceiling: 24 * 365 }),
		},
		earlyLeader: {
			flag: 'EARLY_LEADER_ENABLED',
			enabled: flagOn('EARLY_LEADER_ENABLED', env),
			slots: Math.floor(boundedNumber(env, 'EARLY_LEADER_SLOTS', { def: 20, min: 0, ceiling: CEILINGS.earlyLeader.slots })),
			bonusUsd: boundedNumber(env, 'EARLY_LEADER_BONUS_USD', { def: 50, min: 1, ceiling: CEILINGS.earlyLeader.bonusUsd }),
			weeklyCapUsd: boundedNumber(env, 'EARLY_LEADER_WEEKLY_CAP_USD', { def: 250, min: 0, ceiling: CEILINGS.earlyLeader.weeklyCapUsd }),
			minSettled: Math.floor(boundedNumber(env, 'EARLY_LEADER_MIN_SETTLED', { def: 30, min: 5, ceiling: 10_000 })),
			minSpanDays: boundedNumber(env, 'EARLY_LEADER_MIN_SPAN_DAYS', { def: 30, min: 1, ceiling: 365 }),
			minWinRatePct: boundedNumber(env, 'EARLY_LEADER_MIN_WIN_RATE_PCT', { def: 55, min: 50, ceiling: 100 }),
			minDeployedSol: boundedNumber(env, 'EARLY_LEADER_MIN_DEPLOYED_SOL', { def: 1, min: 0.1, ceiling: 10_000 }),
			maxDrawdownPct: boundedNumber(env, 'EARLY_LEADER_MAX_DRAWDOWN_PCT', { def: 50, min: 1, ceiling: 100 }),
			minFollowers: Math.floor(boundedNumber(env, 'EARLY_LEADER_MIN_FOLLOWERS', { def: 1, min: 1, ceiling: 1000 })),
		},
	};
}

/** The program names, as stored in growth_program_payouts.program. */
export const PAYOUT_PROGRAMS = Object.freeze(['rug_softener', 'early_leader']);

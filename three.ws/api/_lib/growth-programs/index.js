// @ts-check
// Trading growth programs: the entry points the crons, the ops endpoint and the
// report script share. See docs/growth-programs.md for the owner's view.

import { sql as defaultSql } from '../db.js';
import { programConfig, CEILINGS } from './config.js';
import { runBigWinLane } from './big-win-x.js';
import { rugSoftenerCandidates } from './rug-softener.js';
import { earlyLeaderStandings, enrollWinners } from './early-leaders.js';
import { runPayoutQueue } from './payouts.js';

export { programConfig, CEILINGS };

const RUG_PERIOD_HOURS = 24;
const LEADER_PERIOD_HOURS = 24 * 7;

async function solUsdOrNull() {
	const { solPriceUsd } = await import('../sol-price.js');
	const v = await solPriceUsd().catch(() => 0);
	return v > 0 ? v : null;
}

/**
 * The payout tick: enroll any newly qualified early leaders (armed only), then
 * pay each program's queue within its cap (armed only). Disarmed, this reads
 * and reports and changes nothing.
 */
export async function runPayoutPrograms({ env = process.env, sql = defaultSql, deps = null } = {}) {
	const cfg = programConfig(env);

	const leaders = await earlyLeaderStandings(cfg.earlyLeader, { sql });
	let enrolled = 0;
	if (cfg.earlyLeader.enabled && leaders.slots.winners.length) {
		enrolled = await enrollWinners(leaders.slots.winners, cfg.earlyLeader, { sql });
	}

	const queue = (opts) =>
		runPayoutQueue(opts).catch((err) => {
			// The ledger migration has not been applied on this database yet: a
			// clean "nothing to pay" rather than a failed tick.
			if (/growth_program_payouts.*does not exist/i.test(String(err?.message))) {
				return { program: opts.program, armed: opts.enabled, executed: false, reason: 'growth_program_payouts not migrated yet' };
			}
			throw err;
		});

	const [rug, early] = await Promise.all([
		queue({
			program: 'rug_softener',
			enabled: cfg.rugSoftener.enabled,
			flag: cfg.rugSoftener.flag,
			capUsd: cfg.rugSoftener.dailyCapUsd,
			periodHours: RUG_PERIOD_HOURS,
			deps,
			sql,
		}),
		queue({
			program: 'early_leader',
			enabled: cfg.earlyLeader.enabled,
			flag: cfg.earlyLeader.flag,
			capUsd: cfg.earlyLeader.weeklyCapUsd,
			periodHours: LEADER_PERIOD_HOURS,
			deps,
			sql,
		}),
	]);

	return {
		rug_softener: rug,
		early_leader: {
			...early,
			enrolled,
			would_enroll: cfg.earlyLeader.enabled ? [] : leaders.slots.winners.map((w) => ({ agent_id: w.agent_id, name: w.name, qualified_at: w.qualified_at, bonus_usd: cfg.earlyLeader.bonusUsd })),
			open_slots: leaders.slots.open_slots,
		},
	};
}

/**
 * The full dry-run report: what each program would do right now, on real data,
 * and why. Never writes, never sends, never posts.
 */
export async function growthProgramsReport({ env = process.env, sql = defaultSql } = {}) {
	const cfg = programConfig(env);
	const solUsd = await solUsdOrNull();

	const [bigWin, rugCandidates, leaders, ledger] = await Promise.all([
		// Force the lane's dry-run path regardless of the live flag: a report is
		// never allowed to post.
		runBigWinLane({ cfg: { ...cfg.bigWinX, enabled: false }, sql, env }),
		rugSoftenerCandidates(cfg.rugSoftener, { sql, solUsd }),
		earlyLeaderStandings(cfg.earlyLeader, { sql }),
		sql`
			select program, status, count(*)::int as n, coalesce(sum(usd_value), 0)::float as usd
			from growth_program_payouts group by 1, 2 order by 1, 2
		`.catch((err) => (/does not exist/i.test(String(err?.message)) ? [{ note: 'growth_program_payouts not migrated yet' }] : Promise.reject(err))),
	]);

	return {
		generated_at: new Date().toISOString(),
		flags: {
			BIG_WIN_X_ENABLED: cfg.bigWinX.enabled,
			RUG_SOFTENER_ENABLED: cfg.rugSoftener.enabled,
			EARLY_LEADER_ENABLED: cfg.earlyLeader.enabled,
		},
		ceilings: CEILINGS,
		big_win_x: { config: cfg.bigWinX, ...bigWin, armed: cfg.bigWinX.enabled },
		rug_softener: {
			config: cfg.rugSoftener,
			sol_usd: solUsd,
			eligible: rugCandidates.filter((c) => c.eligible),
			would_pay_usd: Math.round(rugCandidates.filter((c) => c.eligible).reduce((s, c) => s + (c.amount?.usd || 0), 0) * 100) / 100,
			candidates: rugCandidates,
		},
		early_leader: {
			config: cfg.earlyLeader,
			open_slots: leaders.slots.open_slots,
			would_enroll: leaders.slots.winners.map((w) => ({ agent_id: w.agent_id, name: w.name, wallet: w.wallet, qualified_at: w.qualified_at, bonus_usd: cfg.earlyLeader.bonusUsd })),
			standings: leaders.standings,
		},
		ledger,
	};
}

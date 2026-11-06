// @ts-check
// Early-leader program (roadmap 917, 13.4): a bounded $THREE bonus for the
// first N traders who build a verified record that followers actually profit
// from. It exists to manufacture a supply of credible leaders before organic
// copy demand does.
//
// "Verified" here means the same truth layer the Trader Card and the copy
// eligibility bar use, never a self-reported number:
//
//   record      live (non-paper) closed round-trips on mainnet from
//               agent_sniper_positions, leaving out P&L on the trader's own
//               coins, the self-dealing rule that trader-stats.js applies
//   thresholds  at least minSettled closes spanning minSpanDays, a win rate of
//               at least minWinRatePct, at least minDeployedSol deployed,
//               positive realized P&L, a max drawdown at or under
//               maxDrawdownPct, and the copyable bar in copy-eligibility.js
//   followers   at least minFollowers distinct copiers (never the leader's own
//               account) with closed copies, whose net copy profit is >= 0,
//               measured the way copy-earnings.js bills performance fees
//   one slot    per owner account, never a platform or service account, only
//               public agents with a Solana wallet to pay
//
// "First N" is by qualification time: the close at which the record FIRST
// cleared every trading threshold. Slots already taken in the ledger are kept.

import { sql as defaultSql } from '../db.js';
import { LEADER_ELIGIBILITY, evaluateLeaderEligibility, summarizeCopyProfile } from '../copy-eligibility.js';
import { selfDealMintsByUsers } from '../trader-stats.js';

const DAY_MS = 86_400_000;
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * The first close at which a record met every trading threshold, walking
 * cumulative stats in close order. PURE.
 *
 * @param {Array<{ realized_pnl_lamports:*, entry_quote_lamports:*, closed_at:* }>} rows oldest first
 * @param {object} cfg programConfig().earlyLeader
 * @returns {string|null} ISO time, or null if the record never qualified
 */
export function qualifiedAt(rows, cfg) {
	let wins = 0;
	let deployed = 0;
	let pnl = 0;
	let peak = 0;
	let maxDd = 0;
	let first = null;
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		const p = n(r.realized_pnl_lamports) / 1e9;
		deployed += n(r.entry_quote_lamports) / 1e9;
		pnl += p;
		if (p > 0) wins += 1;
		if (pnl > peak) peak = pnl;
		maxDd = Math.max(maxDd, peak - pnl);
		const at = new Date(r.closed_at).getTime();
		if (first == null) first = at;
		const settled = i + 1;
		const spanDays = (at - first) / DAY_MS;
		const ddPct = deployed > 0 ? (maxDd / deployed) * 100 : 100;
		if (
			settled >= cfg.minSettled &&
			spanDays >= cfg.minSpanDays &&
			(wins / settled) * 100 >= cfg.minWinRatePct &&
			deployed >= cfg.minDeployedSol &&
			pnl > 0 &&
			ddPct <= cfg.maxDrawdownPct
		) {
			return new Date(at).toISOString();
		}
	}
	return null;
}

/**
 * Judge one leader's current record. PURE.
 *
 * @param {object} rec
 * @param {Array} rec.rows            closed live positions, oldest first, self-dealing removed
 * @param {{ followers:number, net_profit_sol:number }} rec.followers
 * @param {{ is_public:boolean, wallet:string|null, platform:boolean }} rec.agent
 * @param {object} cfg
 */
export function evaluateEarlyLeader(rec, cfg) {
	const rows = rec.rows || [];
	const profile = summarizeCopyProfile(rows);
	const wins = rows.filter((r) => n(r.realized_pnl_lamports) > 0).length;
	const winRate = rows.length ? (wins / rows.length) * 100 : 0;
	const spanDays = profile.span_hours / 24;

	const unmet = [];
	const need = (ok, criterion, label) => {
		if (!ok) unmet.push({ criterion, label });
	};
	need(profile.settled >= cfg.minSettled, 'settled', `${profile.settled} of ${cfg.minSettled} live closed trades`);
	need(spanDays >= cfg.minSpanDays, 'span_days', `${round2(spanDays)} of ${cfg.minSpanDays} days of history`);
	need(winRate >= cfg.minWinRatePct, 'win_rate', `${round2(winRate)}% of ${cfg.minWinRatePct}% win rate`);
	need(profile.deployed_sol >= cfg.minDeployedSol, 'deployed_sol', `${profile.deployed_sol} of ${cfg.minDeployedSol} SOL deployed`);
	need(profile.realized_pnl_sol > 0, 'profitable', `realized P&L is ${profile.realized_pnl_sol} SOL`);
	need(
		profile.max_drawdown_pct != null && profile.max_drawdown_pct <= cfg.maxDrawdownPct,
		'drawdown',
		`max drawdown ${profile.max_drawdown_pct ?? 'n/a'}% (limit ${cfg.maxDrawdownPct}%)`,
	);
	const copyable = evaluateLeaderEligibility(profile, LEADER_ELIGIBILITY);
	need(copyable.eligible, 'copyable', copyable.unmet.map((u) => u.label).join(', ') || 'copyable');
	const f = rec.followers || { followers: 0, net_profit_sol: 0 };
	need(f.followers >= cfg.minFollowers, 'followers', `${f.followers} of ${cfg.minFollowers} copiers with closed copies`);
	need(f.followers === 0 || f.net_profit_sol >= 0, 'follower_outcome', `copiers net ${round4(f.net_profit_sol)} SOL`);
	need(rec.agent?.is_public === true, 'public', 'agent profile is private');
	need(Boolean(rec.agent?.wallet), 'wallet', 'agent has no Solana wallet to pay');
	need(!rec.agent?.platform, 'not_platform', 'platform-owned agents are not eligible');

	return {
		eligible: unmet.length === 0,
		unmet,
		qualified_at: qualifiedAt(rows, cfg),
		stats: {
			settled: profile.settled,
			span_days: round2(spanDays),
			win_rate_pct: round2(winRate),
			deployed_sol: profile.deployed_sol,
			realized_pnl_sol: profile.realized_pnl_sol,
			max_drawdown_pct: profile.max_drawdown_pct,
			followers: f.followers,
			follower_net_profit_sol: round4(f.net_profit_sol),
		},
	};
}

/**
 * Fill the open slots. PURE.
 * Eligible leaders sorted by qualification time; one per owner; slots already
 * taken (in the ledger) count against the total and their owners are skipped.
 *
 * @param {Array<{ agent_id:string, user_id:string, eligible:boolean, qualified_at:string|null }>} standings
 * @param {{ takenAgentIds:Set<string>, takenUserIds:Set<string>, slots:number }} p
 */
export function assignSlots(standings, { takenAgentIds, takenUserIds, slots }) {
	const open = Math.max(0, slots - takenAgentIds.size);
	const owners = new Set(takenUserIds);
	const winners = [];
	const ordered = standings
		.filter((s) => s.eligible && s.qualified_at && !takenAgentIds.has(s.agent_id))
		.sort((a, b) => (a.qualified_at < b.qualified_at ? -1 : a.qualified_at > b.qualified_at ? 1 : a.agent_id < b.agent_id ? -1 : 1));
	for (const s of ordered) {
		if (winners.length >= open) break;
		if (owners.has(s.user_id)) continue;
		owners.add(s.user_id);
		winners.push(s);
	}
	return { open_slots: open, winners };
}

/**
 * Follower outcomes per leader: distinct non-self copiers with closed acted
 * copies, and their net copy profit (copy-earnings.js basis).
 */
async function followerOutcomes(agentIds, sql) {
	const map = new Map();
	if (!agentIds.length) return map;
	const rows = await sql`
		select e.leader_agent_id,
		       count(distinct e.copier_user_id)::int as followers,
		       coalesce(sum(e.planned_sol * (p.realized_pnl_pct / 100.0)), 0)::float as net_profit_sol
		from copy_executions e
		join agent_sniper_positions p on p.id = e.leader_position_id
		join agent_identities a on a.id = e.leader_agent_id
		where e.leader_agent_id = any(${agentIds}::uuid[])
		  and e.direction = 'buy' and e.status = 'acted' and e.network = 'mainnet'
		  and p.status = 'closed' and p.realized_pnl_pct is not null
		  and e.copier_user_id is distinct from a.user_id
		group by e.leader_agent_id
	`.catch(() => []);
	for (const r of rows) map.set(r.leader_agent_id, { followers: n(r.followers), net_profit_sol: n(r.net_profit_sol) });
	return map;
}

/**
 * Every agent with a live mainnet record, judged, plus the slot assignment.
 * @param {object} cfg programConfig().earlyLeader
 */
export async function earlyLeaderStandings(cfg, { sql = defaultSql } = {}) {
	const positions = await sql`
		select p.agent_id, p.user_id, p.mint, p.realized_pnl_lamports, p.entry_quote_lamports, p.closed_at
		from agent_sniper_positions p
		where p.network = 'mainnet' and p.status = 'closed' and p.closed_at is not null
		  and p.buy_sig is not null and p.buy_sig <> 'SIMULATED'
		order by p.closed_at asc
	`;
	const byAgent = new Map();
	for (const p of positions) {
		let list = byAgent.get(p.agent_id);
		if (!list) byAgent.set(p.agent_id, (list = []));
		list.push(p);
	}
	const agentIds = [...byAgent.keys()];
	if (!agentIds.length) return { standings: [], slots: assignSlots([], { takenAgentIds: new Set(), takenUserIds: new Set(), slots: cfg.slots }), taken: [] };

	const [agents, followers, taken] = await Promise.all([
		sql`
			select a.id, a.user_id, a.name, a.is_public, a.meta->>'solana_address' as wallet,
			       coalesce(u.is_admin, false) as is_admin, coalesce(u.service_account, false) as service_account
			from agent_identities a
			left join users u on u.id = a.user_id
			where a.id = any(${agentIds}::uuid[]) and a.deleted_at is null
		`,
		followerOutcomes(agentIds, sql),
		sql`
			select agent_id, user_id, status from growth_program_payouts
			where program = 'early_leader' and status <> 'blocked'
		`.catch(() => []),
	]);
	const selfDeal = await selfDealMintsByUsers(agents.map((a) => a.user_id), 'mainnet');

	const standings = [];
	for (const a of agents) {
		const own = selfDeal.get(a.user_id);
		const rows = (byAgent.get(a.id) || []).filter((r) => !(own && own.has(r.mint)));
		const verdict = evaluateEarlyLeader(
			{
				rows,
				followers: followers.get(a.id) || { followers: 0, net_profit_sol: 0 },
				agent: { is_public: a.is_public === true, wallet: a.wallet || null, platform: Boolean(a.is_admin || a.service_account) },
			},
			cfg,
		);
		standings.push({ agent_id: a.id, user_id: a.user_id, name: a.name, wallet: a.wallet || null, ...verdict });
	}
	standings.sort((x, y) => y.stats.realized_pnl_sol - x.stats.realized_pnl_sol);

	const slots = assignSlots(standings, {
		takenAgentIds: new Set(taken.map((t) => t.agent_id).filter(Boolean)),
		takenUserIds: new Set(taken.map((t) => t.user_id).filter(Boolean)),
		slots: cfg.slots,
	});
	return { standings, slots, taken };
}

/**
 * Commit newly won slots to the ledger ('claimed'), so the payout queue pays
 * them. Only called when the program is armed. Idempotent: the ledger's unique
 * indexes turn a re-run into a no-op.
 */
export async function enrollWinners(winners, cfg, { sql = defaultSql } = {}) {
	let enrolled = 0;
	for (const w of winners) {
		const basis = { stats: w.stats, qualified_at: w.qualified_at, bonus_usd: cfg.bonusUsd };
		const rows = await sql`
			insert into growth_program_payouts
				(program, subject_key, user_id, agent_id, recipient_wallet, usd_value, basis, status)
			values
				('early_leader', ${'agent:' + w.agent_id}, ${w.user_id}, ${w.agent_id}, ${w.wallet},
				 ${cfg.bonusUsd}, ${JSON.stringify(basis)}::jsonb, 'claimed')
			on conflict do nothing
			returning id
		`;
		enrolled += rows.length;
	}
	return enrolled;
}

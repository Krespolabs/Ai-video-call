// Oracle worker — agent action loop.
//
// Polls newly-scored coins and, for every armed agent watch, runs the pure
// decision (agent-eval) against each coin and executes when it clears the bar.
// Each (agent, mint) acts at most once. Simulate-default; live is gated by the
// worker's mode + a hard per-trade cap in the executor.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';
import { evaluateWatch } from '../../api/_lib/oracle/agent-eval.js';
import { executeAction } from './executor.js';
import { alertAgentEntry, alertPersonalEntry, alertPersonalSignal, alertPersonalConvictionDrop, alertFollowers } from '../../api/_lib/oracle/alerts.js';

// Module cursor — only consider verdicts scored since the last pass.
let cursor = new Date(Date.now() - 60_000).toISOString();

// In-memory dedup for conviction-drop alerts: Set of "agentId:mint" pairs alerted
// in this process lifetime. Prevents spam when the same coin stays below threshold
// across multiple score passes.
const _dropAlerted = new Set();

async function armedWatches(network) {
	return sql`
		select w.agent_id, w.user_id, w.network, w.armed, w.mode, w.min_score, w.min_tier,
		       w.categories, w.per_trade_sol, w.max_daily_sol, w.max_open, w.require_smart_money,
		       w.size_scaling, w.telegram_chat_id, a.name as agent_name
		from oracle_agent_watch w
		join agent_identities a on a.id = w.agent_id and a.deleted_at is null
		where w.armed = true and w.network = ${network}
	`.catch(() => []);
}

/** Coins scored since a cursor — the work list for the agent loop and the
 *  alert pass. Returns enough fields for both act decisions and Telegram formatting. */
export async function freshlyScored(network, sinceIso, limit = 60) {
	const rows = await sql`
		select mint, symbol, name, score, tier, category, smart_wallet_count, scored_at,
		       pedigree, structure, narrative, momentum, badges
		from oracle_conviction
		where network = ${network} and scored_at > ${sinceIso}::timestamptz
		order by scored_at asc
		limit ${limit}
	`.catch(() => []);
	// Attach a `pillars` object so downstream consumers (alerts, agent-eval) have
	// a consistent shape regardless of whether the row came from the DB or SSE.
	return rows.map((r) => ({
		...r,
		pillars: { pedigree: r.pedigree, structure: r.structure, narrative: r.narrative, momentum: r.momentum },
	}));
}

/**
 * Find open agent positions that have been re-scored in this pass and whose
 * new conviction has dropped significantly (≥5 pts below entry conviction)
 * AND is now below the agent's min_score. Returns one row per (agent_id, mint).
 * Used for personal conviction-drop exit warnings.
 */
async function droppedConvictionPositions(network, mints) {
	if (!mints.length) return [];
	return sql`
		select a.agent_id, a.mint, a.conviction as entry_conviction,
		       oc.score as new_score, oc.tier as new_tier, oc.symbol,
		       w.min_score, w.telegram_chat_id
		from oracle_watch_actions a
		join oracle_conviction oc on oc.mint = a.mint and oc.network = a.network
		join oracle_agent_watch w on w.agent_id = a.agent_id and w.network = a.network
		where a.network = ${network}
		  and a.mint = any(${mints}::text[])
		  and (a.outcome is null or a.outcome = 'open')
		  and w.armed = true
		  and w.telegram_chat_id is not null
		  and oc.score < w.min_score
		  and (a.conviction::numeric - oc.score::numeric) >= 5
	`.catch((e) => { log.warn('droppedConvictionPositions query failed:', e.message); return []; });
}

/**
 * Open positions + today's committed SOL for every agent in one pass — the
 * batched form of executor.agentBudget, keyed by agent_id. Preserves the exact
 * budget semantics (open = outcome 'open' & status filled/taken; spent = sum of
 * size_sol over the last 24h for filled/taken). Agents with no rows are absent
 * from the Map and default to a zero budget at the call site.
 */
async function agentBudgets(agentIds, network) {
	const map = new Map();
	if (!agentIds.length) return map;
	const rows = await sql`
		select agent_id,
			count(*) filter (where outcome = 'open' and status in ('filled','taken'))::int as open_count,
			coalesce(sum(size_sol) filter (where acted_at > now() - interval '24 hours' and status in ('filled','taken')), 0)::numeric as spent_today
		from oracle_watch_actions
		where agent_id = any(${agentIds}) and network = ${network}
		group by agent_id
	`.catch(() => []);
	for (const r of rows) {
		map.set(r.agent_id, { openCount: Number(r.open_count) || 0, spentTodaySol: Number(r.spent_today) || 0 });
	}
	return map;
}

/**
 * Set of "agentId:mint" pairs that already have an action for the given agents
 * and mints — the batched form of alreadyActed. Scoping to the watch agents and
 * the fresh-coin mints keeps the result bounded.
 */
async function actedPairs(agentIds, mints, network) {
	const set = new Set();
	if (!agentIds.length || !mints.length) return set;
	const rows = await sql`
		select agent_id, mint from oracle_watch_actions
		where agent_id = any(${agentIds}) and mint = any(${mints}) and network = ${network}
	`.catch(() => []);
	for (const r of rows) set.add(`${r.agent_id}:${r.mint}`);
	return set;
}

/**
 * Run every armed watch against a given set of freshly-scored coins. Pure of the
 * cursor so both the long-lived loop and the serverless cron share one code path.
 * Each (agent, mint) acts at most once via the `alreadyActed` guard, so passing
 * an overlapping window across invocations is safe and idempotent.
 */
export async function actOnFreshCoins(cfg, coins) {
	if (cfg.globalKill || !coins.length) return 0;
	const watches = await armedWatches(cfg.network);
	if (!watches.length) return 0;

	// Conviction-drop exit warnings — batch, one query for all fresh mints.
	const freshMints = coins.map((c) => c.mint);
	const drops = await droppedConvictionPositions(cfg.network, freshMints);
	for (const d of drops) {
		const key = `${d.agent_id}:${d.mint}`;
		if (_dropAlerted.has(key)) continue;
		_dropAlerted.add(key);
		alertPersonalConvictionDrop(d.telegram_chat_id, {
			symbol:       d.symbol,
			mint:         d.mint,
			newScore:     Number(d.new_score),
			newTier:      d.new_tier,
			entryScore:   Number(d.entry_conviction),
			minScore:     Number(d.min_score),
		}).catch(() => {});
	}

	// Pre-aggregate budgets (one GROUP BY) and already-acted pairs (one query)
	// for every armed agent against the fresh mints, replacing per-watch and
	// per-(watch,coin) round trips inside the loops below.
	const watchAgentIds = [...new Set(watches.map((w) => w.agent_id))];
	const budgets = await agentBudgets(watchAgentIds, cfg.network);
	const acted = await actedPairs(watchAgentIds, freshMints, cfg.network);

	let actedCount = 0;
	const liveEntries = [];
	for (const watch of watches) {
		const { openCount, spentTodaySol } = budgets.get(watch.agent_id) || { openCount: 0, spentTodaySol: 0 };
		let open = openCount, spent = spentTodaySol;

		// Personal signal alerts: fire once per watch for coins that clear its threshold
		// even if the agent doesn't end up acting (budget full, already acted, etc.).
		if (watch.telegram_chat_id) {
			for (const coin of coins) {
				if ((Number(coin.score) || 0) >= (Number(watch.min_score) || 0)) {
					alertPersonalSignal(watch.telegram_chat_id, coin, Number(watch.min_score) || 0).catch(() => {});
				}
			}
		}

		for (const coin of coins) {
			const decision = evaluateWatch({ watch, coin, openCount: open, spentTodaySol: spent });
			if (!decision.act) continue;
			const actedKey = `${watch.agent_id}:${coin.mint}`;
			if (acted.has(actedKey)) continue;
			const res = await executeAction({ cfg, watch, coin, size: decision.size, reason: decision.reason });
			// executeAction always logs an action row (filled/skipped/failed), so the
			// original per-iteration alreadyActed check would dedup this pair on any
			// later coin in this pass — mirror that by recording it now.
			acted.add(actedKey);
			if (res.status === 'filled') {
				actedCount += 1; open += 1; spent += decision.size;
				// Platform channel: live-mode entries only (too much noise for sim).
				if (watch.mode === 'live' && cfg.mode === 'live') {
					liveEntries.push({
						agent_id: watch.agent_id,
						agent_name: watch.agent_name || null,
						symbol: coin.symbol,
						mint: coin.mint,
						tier: coin.tier,
						conviction: coin.score,
						size_sol: decision.size,
						network: cfg.network,
					});
				}
				// Personal entry alert: always fires if the subscriber has a chat ID.
				if (watch.telegram_chat_id) {
					alertPersonalEntry(watch.telegram_chat_id, {
						agent_name: watch.agent_name || null,
						symbol: coin.symbol,
						mint: coin.mint,
						tier: coin.tier,
						conviction: coin.score,
						size_sol: decision.size,
						mode: watch.mode,
						network: cfg.network,
					}).catch(() => {});
				}
				// Follower fan-out: alert all subscribers of this agent.
				alertFollowers(watch.agent_id, {
					symbol:   coin.symbol,
					mint:     coin.mint,
					tier:     coin.tier,
					score:    coin.score,
					size_sol: decision.size,
					mode:     watch.mode,
					network:  cfg.network,
				}).catch(() => {});
			}
		}
	}
	if (actedCount) log.info(`agent loop: ${actedCount} action(s) across ${watches.length} armed agent(s)`);
	if (liveEntries.length) alertAgentEntry(liveEntries).catch(() => {});
	return actedCount;
}

export async function runAgentPass(cfg) {
	if (cfg.globalKill) return 0;
	const coins = await freshlyScored(cfg.network, cursor);
	if (coins.length) cursor = coins[coins.length - 1].scored_at;
	return actOnFreshCoins(cfg, coins);
}

// agent-sniper — trading-swarm consensus + settlement loops.
//
// A swarm pools multiple agents' capital into one custodial treasury and trades it
// on REPUTATION-WEIGHTED CONSENSUS: the treasury buys a mint only when enough of
// the swarm's combined, verified track record is already long that mint (each
// member's own open position is a real, on-chain "yes" vote). Sizing scales with
// the combined conviction, bounded by swarm policy + the trade firewall (reused
// via executeBuy). Realized profit on close distributes pro-rata to members.
//
// This is a long-lived loop in the sniper worker. It reuses executeBuy unchanged,
// so every swarm buy passes the same spend guards, firewall, and MEV execution as
// a solo snipe — consensus only decides WHICH mints, never bypasses a treasury cap.

import { sql } from '../../api/_lib/db.js';
import { getSmartMoneyForMint } from '../../api/_lib/smart-money.js';
import {
	computeConsensus,
	normalizeSwarmPolicy,
	refreshMemberReputations,
	settleSwarm,
} from '../../api/_lib/swarms.js';
import { executeBuy } from './executor.js';
import { log } from './log.js';

const REPUTATION_TTL_MS = 5 * 60_000;
const VOTE_COOLDOWN_MS = 90_000; // don't re-evaluate the same swarm+mint more often
const CANDIDATE_LOOKBACK = '2 hours';

const _repAt = new Map(); // swarmId → last reputation refresh ts
const _voteAt = new Map(); // `${swarmId}:${mint}` → last vote ts

function cooled(key, ttl) {
	const last = _voteAt.get(key) || 0;
	if (Date.now() - last < ttl) return false;
	_voteAt.set(key, Date.now());
	return true;
}

/**
 * One consensus pass across every active swarm on this network. For each swarm:
 *  1. refresh cached member reputations (throttled to once per TTL),
 *  2. gather candidate mints = mints any member currently holds (their real votes),
 *  3. tally reputation-weighted agreement, gate on smart-money + policy,
 *  4. fire a firewall-gated treasury buy sized by conviction when consensus clears,
 *  5. log the full vote breakdown to swarm_votes either way.
 */
export async function runSwarmConsensus(cfg, { throttle } = {}) {
	if (cfg.globalKill) return;
	const swarms = await sql`
		select * from swarms where network = ${cfg.network} and status = 'active'
	`;
	for (const swarm of swarms) {
		try {
			await evaluateSwarm(cfg, swarm, throttle);
		} catch (err) {
			log.error('swarm consensus failed', { swarm: swarm.id, err: err?.message });
		}
	}
}

async function evaluateSwarm(cfg, swarm, throttle) {
	const pol = normalizeSwarmPolicy(swarm.policy);

	// 1. member set + reputations (vote weights).
	if (Date.now() - (_repAt.get(swarm.id) || 0) > REPUTATION_TTL_MS) {
		await refreshMemberReputations(swarm.id, cfg.network).catch(() => {});
		_repAt.set(swarm.id, Date.now());
	}
	const members = await sql`
		select sm.agent_id, sm.reputation, ai.name
		from swarm_members sm join agent_identities ai on ai.id = sm.agent_id
		where sm.swarm_id = ${swarm.id} and sm.status = 'active'
	`;
	if (members.length < 2) return; // a swarm needs ≥2 members to form consensus
	const memberAgentIds = members.map((m) => m.agent_id);

	// 2. candidate mints: what members are actually long right now (their real,
	// on-chain "yes" votes). A member who recently opened a position in a mint is
	// expressing live conviction we can pool.
	const candidates = await sql`
		select p.mint,
		       coalesce(max(p.symbol),'') as symbol, coalesce(max(p.name),'') as name,
		       array_agg(distinct p.agent_id) as agents
		from agent_sniper_positions p
		where p.agent_id = any(${memberAgentIds}::uuid[]) and p.network = ${cfg.network}
		  and p.status in ('open','opening')
		  and p.opened_at > now() - ${CANDIDATE_LOOKBACK}::interval
		group by p.mint
	`;

	// Treasury already-held mints (skip — executeBuy would no-op anyway).
	const held = new Set(
		(await sql`
			select mint from agent_sniper_positions
			where agent_id = ${swarm.treasury_agent_id} and network = ${cfg.network} and status in ('opening','open','closing')
		`).map((r) => r.mint),
	);

	for (const cand of candidates) {
		if (held.has(cand.mint)) continue;
		if (!cooled(`${swarm.id}:${cand.mint}`, VOTE_COOLDOWN_MS)) continue;

		// 3. smart-money confirmation (real graph read; degrades to zero-data).
		const sm = await getSmartMoneyForMint(cand.mint, cfg.network).catch(() => null);
		const smScore = sm?.computed ? Number(sm.smart_money_score) || 0 : 0;

		const longAgentIds = new Set(cand.agents || []);
		const tally = computeConsensus({ members, longAgentIds, smartMoneyScore: smScore, policy: pol });

		// Policy gates → skip (still logged for the audit trail).
		let skipReason = null;
		if (pol.require_smart_money && (!sm?.computed || (sm.count ?? 0) < 1)) skipReason = 'no_smart_money';
		else if (pol.min_smart_money_score > 0 && smScore < pol.min_smart_money_score) skipReason = 'smart_money_below_min';
		else if (tally.consensus < pol.min_consensus) skipReason = 'below_consensus';

		if (skipReason) {
			await logVote(swarm, cand, tally, smScore, pol, 'skip', null, skipReason);
			continue;
		}

		// 4. size by conviction, bounded by policy max-per-trade.
		const maxPer = BigInt(pol.max_per_trade_lamports);
		const floor = maxPer / 4n;
		let size = BigInt(Math.round(Number(maxPer) * tally.conviction));
		if (size < floor) size = floor;
		if (size > maxPer) size = maxPer;

		const strat = await loadTreasuryStrategy(swarm, size);
		if (!strat) { await logVote(swarm, cand, tally, smScore, pol, 'skip', null, 'no_strategy'); continue; }

		log.info('swarm consensus fire', {
			swarm: swarm.id, mint: cand.mint, consensus: tally.consensus.toFixed(3),
			conviction: tally.conviction.toFixed(3), members_long: tally.members_long, members_total: tally.members_total, smScore,
		});

		const result = await executeBuy({
			cfg, strat, throttle: throttle || { tryConsume: () => true },
			mint: { mint: cand.mint, symbol: cand.symbol || null, name: cand.name || null, entry_trigger: 'swarm_consensus', trigger_ref: swarm.id },
		});

		// Resolve the position id we just opened (if any) for the vote log.
		let positionId = null;
		if (result?.status === 'open') {
			const [p] = await sql`
				select id from agent_sniper_positions
				where agent_id = ${swarm.treasury_agent_id} and mint = ${cand.mint} and network = ${cfg.network}
				order by opened_at desc limit 1`;
			positionId = p?.id || null;
		}
		await logVote(swarm, cand, tally, smScore, pol, result?.status === 'open' ? 'fire' : 'skip', positionId, result?.status === 'open' ? 'consensus_met' : (result?.reason || result?.status || 'not_opened'), size);
	}
}

async function loadTreasuryStrategy(swarm, perTradeOverride) {
	const [strat] = await sql`select * from agent_sniper_strategies where id = ${swarm.strategy_id} limit 1`;
	if (!strat) return null;
	// Clone + size this fire by conviction. Everything else (budget, exits, firewall)
	// stays exactly as the swarm policy configured it; executeBuy enforces all of it.
	return { ...strat, per_trade_lamports: perTradeOverride.toString(), agent_name: `Swarm · ${swarm.name}` };
}

async function logVote(swarm, cand, tally, smScore, pol, decision, positionId, reason, sizeLamports = null) {
	await sql`
		insert into swarm_votes
			(swarm_id, mint, network, decision, consensus, min_consensus, conviction, size_lamports,
			 members_long, members_total, smart_money_score, breakdown, position_id, reason)
		values
			(${swarm.id}, ${cand.mint}, ${swarm.network}, ${decision}, ${tally.consensus}, ${pol.min_consensus},
			 ${tally.conviction}, ${sizeLamports != null ? sizeLamports.toString() : null},
			 ${tally.members_long}, ${tally.members_total}, ${smScore}, ${JSON.stringify(tally.breakdown)}::jsonb,
			 ${positionId}, ${reason})
	`.catch((err) => log.error('swarm vote log failed', { swarm: swarm.id, err: err?.message }));
}

/**
 * Settlement pass: distribute realized profit on newly-closed treasury positions
 * to members pro-rata via real SOL transfers. Runs for active AND killed swarms (a
 * killed swarm still needs its final closes distributed). Idempotent.
 */
export async function runSwarmSettlement(cfg) {
	const swarms = await sql`
		select id, name from swarms where network = ${cfg.network} and status in ('active','paused','killed')
	`;
	for (const swarm of swarms) {
		try {
			const r = await settleSwarm(swarm.id);
			if (r.settled > 0) log.info('swarm settled', { swarm: swarm.id, positions: r.settled, distributed_lamports: r.distributed });
		} catch (err) {
			log.error('swarm settle failed', { swarm: swarm.id, err: err?.message });
		}
	}
}

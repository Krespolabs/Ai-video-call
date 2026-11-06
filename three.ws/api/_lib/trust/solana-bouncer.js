// Agent Bouncer (Solana) — the Pole Club's door bouncer, generalized to the
// whole platform's Solana reputation.
//
// The Club bouncer (api/_lib/club/cover-pass.js) admits a wallet from its club
// history alone: club_tips for a tier, club_bans for exclusion. That trust is
// real but narrow — it only knows what happened at our door.
//
// This module answers the SAME question — "should I engage this agent?" — from
// every Solana signal three.ws indexes about it:
//   • pump_agent_payments   — confirmed on-chain payments accepted, distinct
//                             payers, failure rate (did people actually pay it,
//                             and did those payments succeed?)
//   • pump_distribute_runs  — did it honor its distribute/buyback obligations?
//   • pump_buyback_runs
//   • solana_attestations   — signed Solana memo attestations about it
//                             (threews.feedback / threews.validation)
//   • club_bans / club_tips — the Club's own denylist + door history, folded in
//
// It is behavioral reputation, not a star rating: every input is a real,
// already-settled Solana action, not a claim. `vetSolanaAgent` never throws on a
// weak record — it returns admitted:false with reasons (like the Club turning a
// wallet away). The reads are injectable so the verdict logic is unit-testable
// without a database.

import { sql } from '../db.js';
import { findBan, visitsFor, normalizeWallet } from '../club/cover-pass.js';

// Tier thresholds, keyed off real activity volume + integrity, not a score.
export const TRUSTED_MIN_PAYMENTS = 10;
export const TRUSTED_MIN_PAYERS = 3;
export const TRUSTED_MAX_FAILURE_RATE = 0.2;
export const VIP_MIN_PAYMENTS = 50;
export const VIP_MIN_PAYERS = 10;

/**
 * Load the Solana reputation snapshot for a three.ws agent, synthesized from the
 * on-chain payment / distribution / buyback index and signed Solana memo
 * attestations three.ws maintains. Shared by /api/x402/agent-reputation (which
 * returns the raw snapshot) and the bouncer below (which returns a verdict).
 *
 * @param {string} agentId  three.ws agent_id (UUID)
 * @returns {Promise<object>} reputation snapshot
 */
export async function loadAgentReputation(agentId) {
	// Resolve the agent's Metaplex Core asset pubkey (the column attestations are
	// indexed by). Canonical write path is meta.onchain.sol_asset; legacy rows
	// wrote meta.sol_mint_address.
	const [agentRow] = await sql`
		select
			id,
			name,
			wallet_address,
			coalesce(meta->'onchain'->>'sol_asset', meta->>'sol_mint_address') as agent_asset
		  from agent_identities
		 where id = ${agentId} and deleted_at is null
		 limit 1
	`;
	if (!agentRow) {
		const err = new Error('agent_id not found');
		err.status = 404;
		err.code = 'agent_not_found';
		throw err;
	}

	const mints = await sql`
		select id, mint, network, symbol
		  from pump_agent_mints
		 where agent_id = ${agentId}
		 order by created_at asc
	`;
	const mintIds = mints.map((m) => m.id);

	if (mintIds.length === 0) {
		return {
			agent_id: agentId,
			name: agentRow.name,
			wallet_address: agentRow.wallet_address || null,
			deployed_mints: 0,
			mints: [],
			payments: {
				confirmed_count: 0,
				confirmed_amount_atomics: '0',
				distinct_payers: 0,
				failed_count: 0,
				failure_rate: 0,
			},
			distributions: { confirmed: 0, failed: 0, success_rate: 0 },
			buybacks: { confirmed: 0, failed: 0, total_burn_atomics: '0' },
			attestations: { feedback_count: 0, validation_count: 0, latest_attested_at: null },
			indexed_at: new Date().toISOString(),
		};
	}

	const [payRow] = await sql`
		select
			coalesce(sum(case when status = 'confirmed' then amount_atomics else 0 end), 0)::text
				as confirmed_amount,
			count(*) filter (where status = 'confirmed')::int as confirmed_count,
			count(*) filter (where status = 'failed')::int    as failed_count,
			count(distinct case when status = 'confirmed' then payer_wallet end)::int
				as distinct_payers
		  from pump_agent_payments
		 where mint_id = any(${mintIds})
	`;

	const [distRow] = await sql`
		select
			count(*) filter (where status = 'confirmed')::int as confirmed,
			count(*) filter (where status = 'failed')::int    as failed
		  from pump_distribute_runs
		 where mint_id = any(${mintIds})
	`;

	const [buyRow] = await sql`
		select
			count(*) filter (where status = 'confirmed')::int as confirmed,
			count(*) filter (where status = 'failed')::int    as failed,
			coalesce(sum(case when status = 'confirmed' then burn_amount else 0 end), 0)::text
				as total_burn
		  from pump_buyback_runs
		 where mint_id = any(${mintIds})
	`;

	const [attRow] = agentRow.agent_asset
		? await sql`
			select
				count(*) filter (where kind like 'threews.feedback%' or kind = 'threews.review.v1')::int as feedback_count,
				count(*) filter (where kind like 'threews.validation%')::int                            as validation_count,
				max(block_time)                                                                          as latest_attested_at
			  from solana_attestations
			 where agent_asset = ${agentRow.agent_asset}
			   and revoked = false
		`
		: [{ feedback_count: 0, validation_count: 0, latest_attested_at: null }];

	const totalPayments = payRow.confirmed_count + payRow.failed_count;
	const totalDistribs = distRow.confirmed + distRow.failed;

	return {
		agent_id: agentId,
		name: agentRow.name,
		wallet_address: agentRow.wallet_address || null,
		deployed_mints: mints.length,
		mints: mints.map((m) => ({ mint: m.mint, network: m.network, symbol: m.symbol })),
		payments: {
			confirmed_count: payRow.confirmed_count,
			confirmed_amount_atomics: payRow.confirmed_amount,
			distinct_payers: payRow.distinct_payers,
			failed_count: payRow.failed_count,
			failure_rate: totalPayments ? payRow.failed_count / totalPayments : 0,
		},
		distributions: {
			confirmed: distRow.confirmed,
			failed: distRow.failed,
			success_rate: totalDistribs ? distRow.confirmed / totalDistribs : 0,
		},
		buybacks: {
			confirmed: buyRow.confirmed,
			failed: buyRow.failed,
			total_burn_atomics: buyRow.total_burn,
		},
		attestations: {
			feedback_count: attRow.feedback_count,
			validation_count: attRow.validation_count,
			latest_attested_at: attRow.latest_attested_at
				? new Date(attRow.latest_attested_at).toISOString()
				: null,
		},
		indexed_at: new Date().toISOString(),
	};
}

function attestationTotal(rep) {
	const a = rep.attestations || {};
	return (a.feedback_count || 0) + (a.validation_count || 0);
}

// Agents scoring below this are flagged for trust review by the active-agent
// sweep (api/x402/agent-reputation POST mode → x402_autonomous_log).
export const REPUTATION_FLAG_THRESHOLD = 30;

/**
 * Collapse a reputation snapshot into a single 0..100 trust score, derived
 * purely from settled on-chain behavior. Unproven / inactive agents score low
 * (and are flagged); agents with real paid demand, honored distribution and
 * buyback obligations, and signed attestations score high. Deterministic — the
 * same snapshot always yields the same score, so it is safe to unit-test and to
 * compare across sweeps.
 *
 * Weights (max 100): payments 45 (volume 25 + distinct payers 10 + reliability
 * 10), distributions 15, buybacks 15, attestations 25.
 *
 * @param {object} rep  snapshot from loadAgentReputation
 * @returns {{score:number, flagged:boolean, reasons:string[], breakdown:object}}
 */
export function scoreAgentReputation(rep) {
	const p = (rep && rep.payments) || {};
	const d = (rep && rep.distributions) || {};
	const b = (rep && rep.buybacks) || {};
	const a = (rep && rep.attestations) || {};

	const confirmed = Math.max(0, Number(p.confirmed_count) || 0);
	const payers = Math.max(0, Number(p.distinct_payers) || 0);
	const failureRate = Math.min(1, Math.max(0, Number(p.failure_rate) || 0));

	// Payments — proven demand + reliability (45 pts).
	const volumePts = (Math.min(confirmed, 50) / 50) * 25;
	const payerPts = (Math.min(payers, 10) / 10) * 10;
	const reliabilityPts = confirmed > 0 ? (1 - failureRate) * 10 : 0;

	// Distributions — honored payout obligations (15 pts). Neutral when none ran.
	const distTotal = (Number(d.confirmed) || 0) + (Number(d.failed) || 0);
	const distPts = distTotal > 0 ? (Number(d.success_rate) || 0) * 15 : 0;

	// Buybacks — follow-through on burn commitments (15 pts).
	const buyConfirmed = Number(b.confirmed) || 0;
	const buyTotal = buyConfirmed + (Number(b.failed) || 0);
	const buyPts = buyTotal > 0 ? (buyConfirmed / buyTotal) * 15 : 0;

	// Attestations — signed peer/validator vouches (25 pts).
	const attTotal = (Number(a.feedback_count) || 0) + (Number(a.validation_count) || 0);
	const attPts = (Math.min(attTotal, 10) / 10) * 25;

	const score = Math.round(
		Math.min(100, Math.max(0, volumePts + payerPts + reliabilityPts + distPts + buyPts + attPts)),
	);

	const reasons = [];
	if (confirmed === 0) reasons.push('no confirmed payments on record');
	if (attTotal === 0) reasons.push('no signed attestations');
	if (confirmed > 0 && failureRate > 0.2) {
		reasons.push(`elevated payment failure rate ${(failureRate * 100).toFixed(0)}%`);
	}
	if (distTotal > 0 && (Number(d.success_rate) || 0) < 0.5) {
		reasons.push('distribution success rate below 50%');
	}

	return {
		score,
		flagged: score < REPUTATION_FLAG_THRESHOLD,
		reasons,
		breakdown: {
			payments: Math.round(volumePts + payerPts + reliabilityPts),
			distributions: Math.round(distPts),
			buybacks: Math.round(buyPts),
			attestations: Math.round(attPts),
		},
	};
}

/**
 * The most recently active three.ws agents — ordered by latest settled payment,
 * falling back to mint creation for agents that deployed a token but have not
 * been paid yet. Only agents with at least one pump_agent_mints row qualify
 * (an agent with no token has no Solana track record to score).
 *
 * @param {number} limit  rows to return (already clamped by the caller)
 * @returns {Promise<Array<{id:string,name:string,wallet_address:string,last_active_at:string|null}>>}
 */
async function listRecentlyActiveAgents(limit) {
	const rows = await sql`
		select ai.id, ai.name, ai.wallet_address,
		       max(coalesce(p.confirmed_at, p.created_at, m.created_at)) as last_active_at
		  from agent_identities ai
		  join pump_agent_mints m on m.agent_id = ai.id
		  left join pump_agent_payments p on p.mint_id = m.id
		 where ai.deleted_at is null
		 group by ai.id, ai.name, ai.wallet_address
		 order by last_active_at desc nulls last
		 limit ${limit}
	`;
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		wallet_address: r.wallet_address || null,
		last_active_at: r.last_active_at ? new Date(r.last_active_at).toISOString() : null,
	}));
}

/**
 * Sweep the most recently active agents and score each one's Solana behavioral
 * reputation. Powers the autonomous platform-trust monitor: it returns the live
 * average trust score and flags low-reputation agents (score <
 * REPUTATION_FLAG_THRESHOLD) for review. The reads are injectable so the
 * aggregate logic is unit-testable without a database.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=20]  agents to sweep (clamped 1..50)
 * @param {(id:string)=>Promise<object>} [opts.read]  reputation reader (override in tests)
 * @param {(limit:number)=>Promise<Array>} [opts.list]  active-agent lister (override in tests)
 * @returns {Promise<object>} aggregate sweep result
 */
export async function sweepAgentReputation({
	limit = 20,
	read = loadAgentReputation,
	list = listRecentlyActiveAgents,
} = {}) {
	const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
	const active = await list(n);

	const scored = await Promise.all(
		active.map(async (row) => {
			const rep = await read(row.id);
			const s = scoreAgentReputation(rep);
			return {
				agent_id: rep.agent_id || row.id,
				name: rep.name ?? row.name ?? null,
				wallet_address: rep.wallet_address || row.wallet_address || null,
				deployed_mints: rep.deployed_mints || 0,
				score: s.score,
				flagged: s.flagged,
				reasons: s.reasons,
				breakdown: s.breakdown,
				last_active_at: row.last_active_at || null,
			};
		}),
	);

	const count = scored.length;
	const flagged = scored.filter((agent) => agent.flagged);
	const avgScore = count
		? Math.round(scored.reduce((sum, agent) => sum + agent.score, 0) / count)
		: 0;

	return {
		mode: 'sweep',
		count,
		avg_score: avgScore,
		flagged_count: flagged.length,
		flagged: flagged.map((agent) => ({
			agent_id: agent.agent_id,
			name: agent.name,
			score: agent.score,
			reasons: agent.reasons,
		})),
		agents: scored,
		swept_at: new Date().toISOString(),
	};
}

/**
 * Rank the most recently active agents by Solana behavioral reputation score,
 * highest first. Returns the top N agents with rank assignments so marketplace
 * promotion, partnership outreach, and skill-routing pipelines have a single
 * canonical leaderboard without querying per-agent.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=10]
 * @param {(id:string)=>Promise<object>} [opts.read]
 * @param {(limit:number)=>Promise<Array>} [opts.list]
 */
export async function leaderboardAgentReputation({
	limit = 10,
	read = loadAgentReputation,
	list = listRecentlyActiveAgents,
} = {}) {
	const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
	const active = await list(n);

	const scored = await Promise.all(
		active.map(async (row) => {
			const rep = await read(row.id);
			const s = scoreAgentReputation(rep);
			return {
				agent_id: rep.agent_id || row.id,
				name: rep.name ?? row.name ?? null,
				wallet_address: rep.wallet_address || row.wallet_address || null,
				deployed_mints: rep.deployed_mints || 0,
				score: s.score,
				flagged: s.flagged,
				reasons: s.reasons,
				breakdown: s.breakdown,
				last_active_at: row.last_active_at || null,
			};
		}),
	);

	scored.sort((a, b) => b.score - a.score);
	const ranked = scored.map((agent, i) => ({ ...agent, rank: i + 1 }));

	const count = ranked.length;
	const avgScore = count
		? Math.round(ranked.reduce((sum, a) => sum + a.score, 0) / count)
		: 0;

	return {
		mode: 'leaderboard',
		count,
		avg_score: avgScore,
		agents: ranked,
		generated_at: new Date().toISOString(),
	};
}

// ── Reputation Score History (for decay detection) ───────────────────────────
// Snapshots each agent's current trust score into agent_reputation_score_history
// on every decay_report call. The decay query compares the latest snapshot
// against the most recent baseline that is ≥ 5 days old. Meaningful decay
// comparisons are only possible once 5 days of history exist; earlier calls
// return decayed_count: 0 with has_baseline: false.

let _decayHistorySchemaReady = false;
async function ensureDecayHistorySchema() {
	if (_decayHistorySchemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS agent_reputation_score_history (
			id             bigserial PRIMARY KEY,
			agent_id       uuid NOT NULL,
			score          numeric(5,1) NOT NULL,
			snapshotted_at timestamptz NOT NULL DEFAULT now()
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS arshl_agent_snap
			ON agent_reputation_score_history (agent_id, snapshotted_at DESC)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS arshl_snapshotted
			ON agent_reputation_score_history (snapshotted_at DESC)
	`;
	_decayHistorySchemaReady = true;
}

// Copy rows from agent_reputation_scores (fresh within 24 h) into the history
// table so the decay query has a time series to compare against. Silently
// skips when the source table doesn't exist yet (cold deploy before the cron
// has run for the first time).
async function snapshotCurrentScores() {
	try {
		await sql`
			INSERT INTO agent_reputation_score_history (agent_id, score)
			SELECT agent_id, score
			FROM agent_reputation_scores
			WHERE computed_at >= now() - INTERVAL '24 hours'
		`;
	} catch (err) {
		if (!err?.message?.includes('does not exist')) {
			console.warn('[solana-bouncer] snapshotCurrentScores failed:', err?.message || err);
		}
	}
}

/**
 * Report agents whose behavioral reputation score has declined by more than 10
 * points since the last stored snapshot. Detects coordinated abuse, score
 * manipulation, or legitimately degrading on-chain track records.
 *
 * Each call snapshots current scores into agent_reputation_score_history and
 * compares against the most recent baseline ≥ 5 days old. Returns
 * has_baseline: false until that window is filled (typically after 5 days).
 *
 * @returns {Promise<object>} decay report
 */
export async function decayReportAgentReputation() {
	await ensureDecayHistorySchema();
	await snapshotCurrentScores();

	let hasBaseline = false;
	try {
		const [bc] = await sql`
			SELECT count(*)::int AS cnt
			FROM agent_reputation_score_history
			WHERE snapshotted_at <= now() - INTERVAL '5 days'
		`;
		hasBaseline = (bc?.cnt || 0) > 0;
	} catch { /* table not yet visible on this instance */ }

	if (!hasBaseline) {
		return {
			mode: 'decay_report',
			decayed_count: 0,
			fastest_decline_agent: null,
			avg_decay: 0,
			agents: [],
			has_baseline: false,
			report_at: new Date().toISOString(),
		};
	}

	// h_now = latest snapshot within 2 h (current score after this call's snapshot).
	// h_old = nearest baseline that is ≥ 5 days old.
	// decay = baseline_score − current_score (positive = score dropped).
	let rows = [];
	try {
		rows = await sql`
			SELECT
				h_now.agent_id,
				ai.name,
				h_now.score    AS current_score,
				h_old.score    AS baseline_score,
				(h_old.score - h_now.score)::numeric(5,1) AS decay,
				h_old.snapshotted_at AS baseline_at
			FROM (
				SELECT DISTINCT ON (agent_id) agent_id, score
				FROM agent_reputation_score_history
				WHERE snapshotted_at >= now() - INTERVAL '2 hours'
				ORDER BY agent_id, snapshotted_at DESC
			) h_now
			JOIN agent_identities ai ON ai.id = h_now.agent_id AND ai.deleted_at IS NULL
			JOIN LATERAL (
				SELECT score, snapshotted_at
				FROM agent_reputation_score_history h
				WHERE h.agent_id = h_now.agent_id
				  AND h.snapshotted_at <= now() - INTERVAL '5 days'
				ORDER BY h.snapshotted_at DESC
				LIMIT 1
			) h_old ON true
			WHERE (h_old.score - h_now.score) > 10
			ORDER BY decay DESC
		`;
	} catch (err) {
		console.warn('[solana-bouncer] decayReport query failed:', err?.message || err);
	}

	const decayedCount = rows.length;
	if (!decayedCount) {
		return {
			mode: 'decay_report',
			decayed_count: 0,
			fastest_decline_agent: null,
			avg_decay: 0,
			agents: [],
			has_baseline: true,
			report_at: new Date().toISOString(),
		};
	}

	const top = rows[0];
	const avg_decay =
		Math.round(
			(rows.reduce((s, r) => s + Number(r.decay), 0) / decayedCount) * 10,
		) / 10;

	return {
		mode: 'decay_report',
		decayed_count: decayedCount,
		fastest_decline_agent: {
			agent_id: top.agent_id,
			name: top.name || null,
			current_score: Number(top.current_score),
			baseline_score: Number(top.baseline_score),
			decay: Number(top.decay),
		},
		avg_decay,
		agents: rows.map((r) => ({
			agent_id: r.agent_id,
			name: r.name || null,
			current_score: Number(r.current_score),
			baseline_score: Number(r.baseline_score),
			decay: Number(r.decay),
			baseline_at:
				r.baseline_at instanceof Date ? r.baseline_at.toISOString() : r.baseline_at,
		})),
		has_baseline: true,
		report_at: new Date().toISOString(),
	};
}

/**
 * Door tier from Solana behavioral reputation. Mirrors club/cover-pass.tierFor
 * but reads the whole platform's record instead of club_tips alone. Never
 * returns 'banned' — exclusion is decided by vetSolanaAgent (club_bans).
 *
 * @param {object} rep     snapshot from loadAgentReputation
 * @param {number} visits  prior settled club tips by this agent's wallet
 * @returns {'newcomer'|'regular'|'trusted'|'vip'}
 */
export function tierForSolanaReputation(rep, visits = 0) {
	const p = rep.payments || {};
	const b = rep.buybacks || {};
	const att = attestationTotal(rep);
	const known = (p.confirmed_count || 0) + att + (visits || 0) + (rep.deployed_mints || 0);
	if (known === 0) return 'newcomer'; // no history anywhere yet — cold start

	if (
		(p.confirmed_count || 0) >= VIP_MIN_PAYMENTS &&
		(p.distinct_payers || 0) >= VIP_MIN_PAYERS &&
		((rep.attestations?.validation_count || 0) > 0 || (b.confirmed || 0) > 0)
	) {
		return 'vip';
	}
	if (
		(p.confirmed_count || 0) >= TRUSTED_MIN_PAYMENTS &&
		(p.distinct_payers || 0) >= TRUSTED_MIN_PAYERS &&
		(p.failure_rate || 0) <= TRUSTED_MAX_FAILURE_RATE
	) {
		return 'trusted';
	}
	return 'regular';
}

/**
 * Run the Solana door bouncer over a three.ws agent and return an admission
 * verdict. Mirrors the Club door's contract — { admitted, banned, tier, reason }
 * — but the inputs are the agent's whole Solana track record, not just our door.
 *
 * @param {object} opts
 * @param {string} opts.agentId                three.ws agent_id (UUID)
 * @param {object} [opts.policy]               Admission policy (all optional).
 * @param {number} [opts.policy.minPayments=0]       Required confirmed payments.
 * @param {number} [opts.policy.minDistinctPayers=0] Required distinct payers.
 * @param {number} [opts.policy.maxFailureRate=1]    Max tolerated payment failure rate (0..1).
 * @param {number} [opts.policy.minAttestations=0]   Required signed Solana attestations.
 * @param {boolean} [opts.policy.allowNewcomers=true] Admit agents with no history.
 * @param {(id:string)=>Promise<object>} [opts.read]       Injectable reputation reader.
 * @param {(w:string)=>Promise<object|null>} [opts.banCheck]  Injectable club-ban lookup.
 * @param {(w:string)=>Promise<number>} [opts.visitsCheck]    Injectable club-visit count.
 * @returns {Promise<object>} verdict
 */
export async function vetSolanaAgent({
	agentId,
	policy = {},
	read = loadAgentReputation,
	banCheck = findBan,
	visitsCheck = visitsFor,
}) {
	const {
		minPayments = 0,
		minDistinctPayers = 0,
		maxFailureRate = 1,
		minAttestations = 0,
		allowNewcomers = true,
	} = policy;

	const rep = await read(agentId);
	const wallet = rep.wallet_address ? normalizeWallet(rep.wallet_address) : '';
	const [ban, visits] = await Promise.all([
		wallet ? banCheck(wallet) : Promise.resolve(null),
		wallet ? visitsCheck(wallet) : Promise.resolve(0),
	]);

	const p = rep.payments || {};
	const att = attestationTotal(rep);
	const totalActivity = (p.confirmed_count || 0) + att + (visits || 0) + (rep.deployed_mints || 0);
	const isNewcomer = totalActivity === 0;

	const reasons = [];
	let banned = false;
	if (ban) {
		banned = true;
		reasons.push(ban.reason || 'wallet is on the club ban list');
	}

	if (!allowNewcomers && isNewcomer) {
		reasons.push('no Solana track record yet — newcomers not admitted by this policy');
	}
	if (minPayments > 0 && (p.confirmed_count || 0) < minPayments) {
		reasons.push(`only ${p.confirmed_count || 0} confirmed payment(s); ${minPayments} required`);
	}
	if (minDistinctPayers > 0 && (p.distinct_payers || 0) < minDistinctPayers) {
		reasons.push(`only ${p.distinct_payers || 0} distinct payer(s); ${minDistinctPayers} required`);
	}
	const settledPayments = (p.confirmed_count || 0) + (p.failed_count || 0);
	if (maxFailureRate < 1 && settledPayments > 0 && (p.failure_rate || 0) > maxFailureRate) {
		reasons.push(
			`payment failure rate ${(p.failure_rate * 100).toFixed(1)}% exceeds the ${(maxFailureRate * 100).toFixed(0)}% limit`,
		);
	}
	if (minAttestations > 0 && att < minAttestations) {
		reasons.push(`only ${att} signed attestation(s); ${minAttestations} required`);
	}

	const admitted = !banned && reasons.length === 0;
	const tier = banned ? 'banned' : tierForSolanaReputation(rep, visits);

	return {
		admitted,
		banned,
		tier,
		reason: reasons[0] || null,
		reasons,
		newcomer: isNewcomer,
		agent_id: rep.agent_id,
		name: rep.name,
		wallet_address: rep.wallet_address || null,
		visits,
		reputation: {
			deployed_mints: rep.deployed_mints,
			payments: rep.payments,
			distributions: rep.distributions,
			buybacks: rep.buybacks,
			attestations: rep.attestations,
		},
	};
}

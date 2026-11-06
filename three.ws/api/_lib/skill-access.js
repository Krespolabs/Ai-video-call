// Skill access — single source of truth for "does user X own skill Y on agent Z?".
//
// Usage: every server endpoint that executes a paid skill should call hasSkillAccess
// before doing the work. Agent-to-agent x402 callers go through verifyPaid in x402.js
// instead; this helper covers the human-buyer / direct-API path.
//
// A user is granted access through any one of (checked in priority order so a
// confirmed purchase or a subscription is never satisfied by burning a trial):
//   0. NFT gate (gate_type = 'nft') — access requires holding ≥1 NFT from the
//      configured collection in a linked wallet. Not a purchase: no payment, no
//      ledger row. Verified live on-chain and FAIL-CLOSED (an RPC error denies).
//   1. The skill is not priced in agent_skill_prices  → free, always allowed.
//   2. A confirmed one-time purchase in skill_purchases (honouring time-passes).
//   3. An agent-level flat subscription (user_agent_subscriptions) — covers
//      every paid skill on the agent.
//   4. A creator subscription tier (creator_subscriptions → subscription_plans)
//      whose included_skills array lists this skill.
//   5. An active trial with remaining uses.
//
// Returns { paid, owned, price?, reason?, via_subscription?, trial?, trial_remaining?, gate? }
//   paid    — boolean: is this skill access-gated in agent_skill_prices?
//   owned   — boolean: may the user execute it right now?
//   price   — { skill, amount, currency_mint, chain } when paid; undefined otherwise
//   reason  — short string when access is denied ('not_purchased' | 'trial_exhausted'
//             | 'expired' | 'nft_required' | 'nft_check_failed')
//   gate    — { type: 'nft', collection } when the skill is NFT-gated

import { sql } from './db.js';
import { userHoldsCollection } from './nft-gate.js';

export async function hasSkillAccess(userId, agentId, skill) {
	const [price] = await sql`
		SELECT skill, amount, currency_mint, chain, gate_type, nft_collection_mint
		FROM agent_skill_prices
		WHERE agent_id = ${agentId} AND skill = ${skill} AND is_active = true
	`;
	if (!price) return { paid: false, owned: true };

	// 0. NFT gate — access is holding the collection, not a purchase. Resolved on
	// its own path: trials / time-passes / subscriptions don't apply.
	if (price.gate_type === 'nft' && price.nft_collection_mint) {
		const gate = { type: 'nft', collection: price.nft_collection_mint };
		if (!userId) return { paid: true, owned: false, price, gate, reason: 'nft_required' };
		try {
			const held = await userHoldsCollection(userId, price.nft_collection_mint);
			return held
				? { paid: true, owned: true, price, gate, via_nft: true }
				: { paid: true, owned: false, price, gate, reason: 'nft_required' };
		} catch (err) {
			// Fail-closed: a verification failure must never unlock a gated skill.
			console.error('[skill-access] nft gate check failed', err?.message);
			return { paid: true, owned: false, price, gate, reason: 'nft_check_failed' };
		}
	}

	if (!userId) return { paid: true, owned: false, price, reason: 'not_purchased' };

	// Best purchase row for this (user, agent, skill): a confirmed purchase wins
	// over a trial. Fetched up front so trials are only consumed when nothing
	// stronger (purchase or subscription) already grants access.
	const [purchase] = await sql`
		SELECT status, valid_until, trial_remaining
		FROM skill_purchases
		WHERE user_id = ${userId} AND agent_id = ${agentId} AND skill = ${skill}
		  AND status IN ('confirmed', 'trial')
		ORDER BY
			(status = 'confirmed') DESC,    -- confirmed beats trial
			confirmed_at DESC NULLS LAST,
			created_at DESC
		LIMIT 1
	`;

	// 2. Confirmed one-time purchase (honour time-limited passes).
	const confirmedExpired =
		purchase?.status === 'confirmed' &&
		purchase.valid_until &&
		new Date(purchase.valid_until) <= new Date();
	if (purchase?.status === 'confirmed' && !confirmedExpired) {
		return { paid: true, owned: true, price };
	}

	// 3. Agent-level flat subscription grants access to every paid skill on this agent.
	const [flatSub] = await sql`
		SELECT id FROM user_agent_subscriptions
		WHERE user_id = ${userId}
		  AND agent_id = ${agentId}
		  AND status = 'active'
		  AND current_period_ends_at > now()
		LIMIT 1
	`.catch(() => []);
	if (flatSub) return { paid: true, owned: true, price, via_subscription: true };

	// 4. Creator subscription tier whose included_skills covers this skill. A tier
	// matches when it is scoped to this agent, or is creator-wide (agent_id NULL)
	// and owned by this agent's creator.
	const [tierSub] = await sql`
		SELECT cs.id
		FROM creator_subscriptions cs
		JOIN subscription_plans sp ON sp.id = cs.plan_id
		JOIN agent_identities ai ON ai.id = ${agentId}
		WHERE cs.subscriber_user_id = ${userId}
		  AND cs.status = 'active'
		  AND cs.current_period_end > now()
		  AND ${skill} = ANY(sp.included_skills)
		  AND (sp.agent_id = ${agentId} OR (sp.agent_id IS NULL AND sp.creator_id = ai.user_id))
		LIMIT 1
	`.catch(() => []);
	if (tierSub) return { paid: true, owned: true, price, via_subscription: true };

	// 5. Active trial with remaining uses (consumed by the caller on success).
	if (purchase?.status === 'trial') {
		if ((purchase.trial_remaining ?? 0) <= 0) {
			return { paid: true, owned: false, price, reason: 'trial_exhausted' };
		}
		return { paid: true, owned: true, price, trial: true, trial_remaining: purchase.trial_remaining };
	}

	// Denied — distinguish an expired time-pass from a skill never purchased.
	if (confirmedExpired) return { paid: true, owned: false, price, reason: 'expired' };
	return { paid: true, owned: false, price, reason: 'not_purchased' };
}

// Decrement trial counter atomically. Caller invokes after a successful trial use.
// Returns the new remaining count, or null if no trial row matched.
export async function consumeTrialUse(userId, agentId, skill) {
	const [row] = await sql`
		UPDATE skill_purchases
		SET trial_remaining = trial_remaining - 1, updated_at = now()
		WHERE user_id = ${userId} AND agent_id = ${agentId} AND skill = ${skill}
		  AND status = 'trial' AND trial_remaining > 0
		RETURNING trial_remaining
	`;
	return row?.trial_remaining ?? null;
}

// Fire-and-forget usage log. Never awaited on the hot path — failures are
// swallowed so they cannot impact the caller's response latency or error state.
export function logSkillUsage({ userId, agentId, skillName, status = 'success', executionTimeMs = null }) {
	sql`
		INSERT INTO skill_usage_logs (user_id, agent_id, skill_name, status, execution_time_ms)
		VALUES (${userId ?? null}, ${agentId}, ${skillName}, ${status}, ${executionTimeMs})
	`.catch((err) => console.error('[skill-usage-log]', err?.message));
}

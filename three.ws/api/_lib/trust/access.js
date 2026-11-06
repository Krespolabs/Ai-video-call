// Wallet access — the SERVER-AUTHORITATIVE enforcement of reputation unlocks.
//
// src/shared/wallet-access-rules.js holds the pure rule catalog (shared with the
// client for display). This module is where those rules become real gates: it
// computes the unlock state from a server-side reputation result (which the client
// cannot forge — every input is a real DB/on-chain read) and enforces ownership +
// requirements before granting any real capability.
//
//   • getAgentUnlocks(agentId)     — an agent's unlock state (public trust signal).
//   • requireUnlock(req, opts)     — gate a capability: re-checks ownership AND the
//                                    requirement server-side, throws on failure.
//   • claimUnlock / listClaimed    — persist an unlocked cosmetic to the agent's
//                                    record (a real, owner-only state change), only
//                                    when the server confirms the unlock.

import { sql } from '../db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../auth.js';
import { getEffectiveReputation } from './reputation-store.js';
import { REPUTATION_VERSION } from './wallet-reputation.js';
import {
	ACCESS_RULES,
	evaluateAllAccess,
	evaluateAccessKey,
	buildAccessContext,
} from '../../../src/shared/wallet-access-rules.js';

// Only cosmetic unlocks can be "claimed" into the agent record — world-area gates
// are evaluated live at entry, not owned.
const CLAIMABLE_SURFACES = new Set(['cosmetic']);

class AccessError extends Error {
	constructor(code, message, status) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

/**
 * Resolve the authenticated user id from a session cookie or bearer token.
 * Returns null for an anonymous caller.
 */
export async function resolveUserId(req) {
	try {
		const session = await getSessionUser(req);
		if (session) return session.id;
		const bearer = await authenticateBearer(extractBearer(req));
		if (bearer) return bearer.userId;
	} catch {
		/* anonymous */
	}
	return null;
}

/**
 * The full unlock state for an agent, derived from its server-computed reputation.
 * Public: an agent's tier and what it has unlocked is a trust signal others rely
 * on. Includes the claimed-cosmetic set so the UI knows what's already owned.
 *
 * @param {string} agentId
 * @returns {Promise<object>} { agent_id, tier, score, isNew, context, unlocks[], claimed[], version, computed_at, partial }
 */
export async function getAgentUnlocks(agentId) {
	const rep = await getEffectiveReputation(agentId);
	const context = buildAccessContext(rep);
	const claimed = await listClaimed(agentId);
	const claimedSet = new Set(claimed);
	const unlocks = evaluateAllAccess(context).map((u) => ({
		...u,
		claimable: CLAIMABLE_SURFACES.has(u.surface),
		claimed: claimedSet.has(u.key),
	}));
	return {
		agent_id: agentId,
		tier: rep.tier,
		tierLabel: rep.tierLabel,
		score: rep.score,
		isNew: rep.isNew,
		accent: rep.accent,
		context,
		unlocks,
		claimed,
		version: REPUTATION_VERSION,
		computed_at: rep.computed_at,
		partial: Boolean(rep.partial),
	};
}

/**
 * Gate a real capability behind an unlock. Re-checks server-side that:
 *   1. the caller is authenticated,
 *   2. the caller OWNS the agent the check is for (ownership is server-truth,
 *      never a client flag), and
 *   3. that agent's live reputation actually meets the unlock requirement.
 * Throws AccessError (with .status) on any failure; returns the evaluation on
 * success. This is the only correct way to grant access to a protected capability.
 *
 * @param {object} req
 * @param {object} opts { agentId, key }
 * @returns {Promise<{ unlock: object, rep: object, userId: string }>}
 */
export async function requireUnlock(req, { agentId, key }) {
	const rule = ACCESS_RULES.find((r) => r.key === key);
	if (!rule) throw new AccessError('unknown_unlock', `unknown unlock: ${key}`, 400);

	const userId = await resolveUserId(req);
	if (!userId) throw new AccessError('unauthenticated', 'sign in to use this', 401);

	const [owned] = await sql`
		select 1 from agent_identities where id = ${agentId} and user_id = ${userId} and deleted_at is null limit 1
	`.catch(() => []);
	if (!owned) throw new AccessError('not_owner', 'you do not own this agent', 403);

	const rep = await getEffectiveReputation(agentId);
	const unlock = evaluateAccessKey(key, buildAccessContext(rep));
	if (!unlock?.unlocked) {
		throw new AccessError(
			'locked',
			unlock?.nextHint ? `Locked — ${unlock.nextHint}` : 'reputation requirement not met',
			403,
		);
	}
	return { unlock, rep, userId };
}

/**
 * Persist a claimed cosmetic unlock onto the agent record (meta.unlocks[]). A real,
 * owner-only capability — guarded by requireUnlock, so the server has already
 * confirmed ownership AND that the cosmetic is genuinely unlocked. Idempotent.
 *
 * @param {object} req
 * @param {object} opts { agentId, key }
 * @returns {Promise<{ claimed: string[], unlock: object }>}
 */
export async function claimUnlock(req, { agentId, key }) {
	const rule = ACCESS_RULES.find((r) => r.key === key);
	if (!rule) throw new AccessError('unknown_unlock', `unknown unlock: ${key}`, 400);
	if (!CLAIMABLE_SURFACES.has(rule.surface)) {
		throw new AccessError('not_claimable', 'this unlock is granted live, not claimed', 400);
	}
	// Re-authorizes ownership + requirement server-side.
	const { unlock } = await requireUnlock(req, { agentId, key });

	// Append the key to meta.unlocks (a jsonb array) without clobbering other meta.
	await sql`
		update agent_identities
		set meta = jsonb_set(
			coalesce(meta, '{}'::jsonb),
			'{unlocks}',
			coalesce(meta->'unlocks', '[]'::jsonb) ||
				case when coalesce(meta->'unlocks', '[]'::jsonb) @> ${JSON.stringify([key])}::jsonb
					then '[]'::jsonb else ${JSON.stringify([key])}::jsonb end
		)
		where id = ${agentId} and deleted_at is null
	`;
	const claimed = await listClaimed(agentId);
	return { claimed, unlock };
}

/** The cosmetic unlock keys an agent has claimed (meta.unlocks). */
export async function listClaimed(agentId) {
	try {
		const [row] = await sql`
			select coalesce(meta->'unlocks', '[]'::jsonb) as unlocks
			from agent_identities where id = ${agentId} and deleted_at is null limit 1
		`;
		const arr = row?.unlocks;
		return Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : [];
	} catch {
		return [];
	}
}

export { AccessError };

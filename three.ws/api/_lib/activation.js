// User activation — the single, idempotent "first win" marker.
//
// Activation is the funnel milestone that separates a signup from a user who
// actually reached value. On three.ws the first win is producing a real 3D
// creation (saving an avatar / claiming a forged model). The first time that
// happens for an account we stamp users.activated_at, emit an `activation` event
// for the growth funnel, and — if the account was referred — pay the two-sided
// referral reward (api/_lib/referral-rewards.js).
//
// markActivated is safe to call from every first-win site: the
// `WHERE activated_at IS NULL` guard makes the stamp, the event, and the reward
// fire exactly once per account no matter how many call sites or concurrent
// requests race. It never throws — activation is a side-effect of the real
// action, never a precondition for it.

import { sql } from './db.js';
import { recordEvent } from './usage.js';
import { grantReferralActivationReward } from './referral-rewards.js';

/**
 * Mark a user activated on their first win. Idempotent: only the first call per
 * user transitions the account; subsequent calls are cheap no-ops.
 *
 * @param {string} userId
 * @param {{ source?: string, meta?: object }} [opts]
 *   source — what triggered activation (e.g. 'avatar_create', 'forge_save')
 * @returns {Promise<{ activated: boolean, alreadyActive: boolean }>}
 *   activated=true only on the transition that newly activated the account.
 */
export async function markActivated(userId, { source = 'unknown', meta = {} } = {}) {
	if (!userId) return { activated: false, alreadyActive: false };
	try {
		// Atomic set-once: RETURNING is empty when the row was already activated
		// (or doesn't exist), so only the first writer proceeds to side-effects.
		const [row] = await sql`
			update users set activated_at = now()
			where id = ${userId} and deleted_at is null and activated_at is null
			returning id
		`;
		if (!row) return { activated: false, alreadyActive: true };

		recordEvent({
			userId,
			kind: 'activation',
			meta: { source, ...meta },
		});

		// Two-sided referral reward — best-effort, never blocks activation.
		grantReferralActivationReward({ referredUserId: userId }).catch((err) =>
			console.error('[activation] reward failed', err?.message),
		);

		return { activated: true, alreadyActive: false };
	} catch (err) {
		console.error('[activation] markActivated failed', err?.message);
		return { activated: false, alreadyActive: false };
	}
}

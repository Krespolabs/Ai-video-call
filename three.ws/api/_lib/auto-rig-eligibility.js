// Auto-rig plan / $THREE-holder eligibility gate.
//
// Auto-rigging is a paid perk: each job is real UniRig GPU time. This module is
// the deliberate plan lever — the place a config change can restrict the perk to
// paying customers or $THREE holders without touching the auto-rig pipeline.
//
// Default policy (AUTO_RIG_REQUIRE_TIER unset/empty/'none'/'member'/'off'): every
// authenticated owner passes — current behaviour is unchanged, and the abuse
// caps in api/_lib/rate-limit.js (rig / rigDaily / rigGlobal) are the real teeth.
// Tightening is a single env var: set AUTO_RIG_REQUIRE_TIER to a $THREE tier id
// (bronze | silver | gold | genesis) or level (1–4) and the perk is gated to that
// holder tier (paying-plan subscribers still pass — a paid plan is itself a paying
// relationship). The lever EXISTS and is wired; raising it is config, not code.

import { sql } from './db.js';
import { resolveUserTier, TIERS } from './three-tier.js';

// Subscription plans that always get the auto-rig perk regardless of $THREE
// holdings — a paid plan is its own proof of a paying relationship. `null` /
// 'free' do not appear here, so a free account is gated by the tier requirement.
const PAID_PLANS = new Set(['pro', 'team', 'enterprise', 'studio', 'business']);

// Resolve the minimum $THREE tier LEVEL the env requires, or 0 (no requirement).
// Accepts a tier id ('silver') or a numeric level ('2'); an unrecognised value
// degrades to 0 (open) rather than silently locking everyone out.
function requiredTierLevel() {
	const want = String(process.env.AUTO_RIG_REQUIRE_TIER || '').trim().toLowerCase();
	if (!want || want === 'none' || want === 'member' || want === 'off' || want === '0') return 0;
	const byId = TIERS.find((t) => t.id === want);
	if (byId) return byId.level;
	const lvl = Number(want);
	if (Number.isFinite(lvl) && lvl > 0) return Math.min(lvl, TIERS[TIERS.length - 1].level);
	return 0;
}

function planQualifies(plan) {
	return Boolean(plan) && PAID_PLANS.has(String(plan).toLowerCase());
}

/**
 * Is this owner eligible to spend a paid auto-rig job?
 *
 * @param {{ userId: string, plan?: string|null }} opts
 * @returns {Promise<boolean>} Never throws.
 *
 * Fail-closed when a tier IS required and resolution errors: the money path must
 * not be bypassable via a balance/price outage. In the default-open posture this
 * never runs a query — it returns true before touching the DB or price feed.
 */
export async function isAutoRigEligible({ userId, plan = null } = {}) {
	const needLevel = requiredTierLevel();
	if (needLevel <= 0) return true; // default policy: all authenticated owners.
	if (planQualifies(plan)) return true;
	if (!userId) return false;
	try {
		const rows = await sql`
			select plan, wallet_address from users where id = ${userId} limit 1
		`;
		const u = rows[0];
		if (!u) return false;
		if (planQualifies(u.plan)) return true;
		const { tier } = await resolveUserTier(u);
		return (tier?.level || 0) >= needLevel;
	} catch (err) {
		console.warn('[auto-rig] eligibility check degraded → denying (tier required):', err?.message);
		return false;
	}
}

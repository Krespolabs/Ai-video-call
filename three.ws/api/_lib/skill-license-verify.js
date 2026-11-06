// Trustless on-chain license gate for skill execution.
// ---------------------------------------------------------------------------
// The DB grant (skill_access_grants) is the fast entitlement check. This adds
// the TRUSTLESS layer the marketplace promises: when a skill purchase minted an
// on-chain `skill_license` (a 1/1 SPL NFT + PDA), the executor honors the
// on-chain state as authoritative for REVOCATION — a license revoked on chain
// (e.g. on refund) blocks execution even if a stale DB row lingers. Entitlement
// is then enforced by the chain, not just a database row.
//
// Design choices (matching the reliability bar):
//   • Fail-OPEN on infrastructure trouble: if the program isn't deployed, the
//     agent has no on-chain collection, no license was minted, RPC errors, or
//     enforcement is off, we DON'T block a user the DB already cleared. We only
//     ever block on an AFFIRMATIVELY READ on-chain revocation. A paid user is
//     never locked out by a node hiccup.
//   • Opt-in cost: the on-chain read only runs when SKILL_LICENSE_ENFORCE is
//     truthy, so the hot pay-per-call path isn't taxed with RPC latency unless
//     the operator turns enforcement on.

import { verifyOnchainSkillLicense } from './skill-license-onchain.js';

/** Is on-chain license enforcement turned on for this environment? */
export function licenseEnforcementEnabled() {
	const v = (process.env.SKILL_LICENSE_ENFORCE || '').trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Decide whether an on-chain license revocation should block execution of a
 * skill the DB already granted. Returns { blocked, reason?, license? }.
 *
 * @param {object} o
 * @param {Function} o.sql
 * @param {string} o.userId   - the caller (beneficiary) user id
 * @param {string} o.agentId
 * @param {string} o.skill
 * @returns {Promise<{ blocked: boolean, reason?: string, license?: string, network?: string }>}
 */
export async function enforceOnchainLicense({ sql, userId, agentId, skill }) {
	if (!licenseEnforcementEnabled()) return { blocked: false };

	// Was an on-chain license actually minted for this beneficiary's purchase?
	// Only those are subject to on-chain revocation — a skill that never minted a
	// license (no collection / no wallet) stays purely DB-gated.
	let mint;
	try {
		[mint] = await sql`
			SELECT owner_wallet, agent_mint, network, status
			FROM skill_license_mints
			WHERE user_id = ${userId} AND agent_id = ${agentId} AND skill = ${skill}
			  AND status IN ('minted', 'already')
			ORDER BY updated_at DESC
			LIMIT 1
		`;
	} catch {
		return { blocked: false }; // table missing → nothing to enforce
	}
	if (!mint?.owner_wallet || !mint?.agent_mint) return { blocked: false };

	try {
		const network = mint.network === 'devnet' ? 'devnet' : 'mainnet';
		const v = await verifyOnchainSkillLicense({
			ownerWallet: mint.owner_wallet,
			agentMint: mint.agent_mint,
			skill,
			network,
		});
		// Program not deployed in this env, or the PDA can't be read → degrade to
		// the DB grant (fail-open). Only a real, decoded revocation blocks.
		if (!v.deployed || !v.exists) return { blocked: false };
		if (v.revoked) {
			return { blocked: true, reason: 'license_revoked_onchain', license: v.license, network };
		}
		return { blocked: false, license: v.license, network };
	} catch {
		return { blocked: false }; // RPC trouble must never lock out a paid user
	}
}

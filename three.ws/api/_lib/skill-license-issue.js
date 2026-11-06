// Issue + record the on-chain skill license for a confirmed purchase.
// ---------------------------------------------------------------------------
// After a skill purchase confirms, the buyer's entitlement is proven two ways:
//   1. the DB grant (skill_access_grants) — fast, always available;
//   2. a trustless on-chain license (the `skill_license` Anchor program) — a
//      1/1 SPL NFT + PDA the skill executor can verify without trusting our DB.
//
// This module bridges (1)→(2): it resolves the beneficiary's Solana wallet and
// the agent's on-chain skill-collection mint, mints the license server-side
// (minter-signed), and records the mint in `skill_license_mints` so the
// dashboard can show a license count and the executor can read back a proof.
//
// It DEGRADES, never fails the purchase: if the agent has no on-chain
// collection, the beneficiary has no Solana wallet, or the minter key / program
// isn't deployed, it records `status='skipped'` (with a reason) and returns —
// the purchase stays confirmed and access still works via the DB grant. It
// never fakes a license it did not actually mint (CLAUDE.md Rule 1 & 9).

import { isValidSolanaAddress } from './validate.js';
import { mintSkillLicenseOnchain, SKILL_LICENSE_PROGRAM_ID } from './skill-license-onchain.js';

/** Resolve a beneficiary's Solana (base58) wallet address, or null. */
async function resolveSolanaWallet(sql, userId) {
	if (!userId) return null;
	try {
		const rows = await sql`
			SELECT address FROM user_wallets
			WHERE user_id = ${userId}
			ORDER BY is_primary DESC NULLS LAST, created_at ASC
		`;
		for (const r of rows) {
			if (isValidSolanaAddress(r.address)) return r.address;
		}
	} catch {
		/* table shape differs in some envs — fall through to null */
	}
	return null;
}

/**
 * Mint + record the on-chain license for a confirmed `skill_purchases` row.
 * Best-effort and self-contained: returns a small status object and never
 * throws into the confirm path.
 *
 * @param {Function} sql
 * @param {object} pur - confirmed purchase row (id, agent_id, skill, user_id, recipient_user_id, chain)
 * @returns {Promise<{ status:'minted'|'already'|'skipped', reason?:string, license?:string, signature?:string }>}
 */
export async function recordOnchainLicenseForPurchase(sql, pur) {
	const beneficiaryId = pur.recipient_user_id || pur.user_id;

	const [agent] = await sql`
		SELECT skill_collection_mint, skill_collection_network
		FROM agent_identities WHERE id = ${pur.agent_id}
	`;
	const agentMint = agent?.skill_collection_mint || null;
	if (!agentMint) return recordMint(sql, pur, beneficiaryId, { status: 'skipped', reason: 'agent_has_no_onchain_collection' });

	const ownerWallet = await resolveSolanaWallet(sql, beneficiaryId);
	if (!ownerWallet) return recordMint(sql, pur, beneficiaryId, { status: 'skipped', reason: 'beneficiary_has_no_solana_wallet' });

	const network = agent.skill_collection_network === 'devnet' ? 'devnet' : 'mainnet';

	try {
		const res = await mintSkillLicenseOnchain({ ownerWallet, agentMint, skill: pur.skill, network });
		return recordMint(sql, pur, beneficiaryId, {
			status: res.alreadyMinted ? 'already' : 'minted',
			ownerWallet,
			agentMint,
			network,
			license: res.license,
			nftMint: res.nftMint,
			signature: res.signature,
		});
	} catch (e) {
		// minter_unconfigured / program-not-deployed / RPC — record skip, keep the
		// purchase confirmed. The DB grant is the working entitlement meanwhile.
		const reason = e?.code === 'minter_unconfigured' ? 'minter_unconfigured' : e?.message?.slice(0, 200) || 'mint_failed';
		return recordMint(sql, pur, beneficiaryId, { status: 'skipped', reason, ownerWallet, agentMint, network });
	}
}

// Upsert the mint record (one per purchase). Tolerates a missing table so the
// confirm path is unaffected before the migration runs.
async function recordMint(sql, pur, beneficiaryId, fields) {
	try {
		await sql`
			INSERT INTO skill_license_mints
				(purchase_id, user_id, agent_id, skill, owner_wallet, agent_mint, network,
				 program_id, license_pda, nft_mint, tx_signature, status, reason)
			VALUES
				(${pur.id}, ${beneficiaryId}, ${pur.agent_id}, ${pur.skill},
				 ${fields.ownerWallet ?? null}, ${fields.agentMint ?? null}, ${fields.network ?? null},
				 ${SKILL_LICENSE_PROGRAM_ID}, ${fields.license ?? null}, ${fields.nftMint ?? null},
				 ${fields.signature ?? null}, ${fields.status}, ${fields.reason ?? null})
			ON CONFLICT (purchase_id) DO UPDATE SET
				status        = EXCLUDED.status,
				reason        = EXCLUDED.reason,
				license_pda   = COALESCE(EXCLUDED.license_pda, skill_license_mints.license_pda),
				nft_mint      = COALESCE(EXCLUDED.nft_mint, skill_license_mints.nft_mint),
				tx_signature  = COALESCE(EXCLUDED.tx_signature, skill_license_mints.tx_signature),
				updated_at    = now()
		`;
	} catch (e) {
		if (!e?.message?.includes('does not exist')) {
			console.error('[skill-license-issue] record failed', e?.message);
		}
	}
	return { status: fields.status, reason: fields.reason, license: fields.license, signature: fields.signature };
}

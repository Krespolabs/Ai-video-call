// Oracle worker — agent keypair loading for live execution.
//
// Mirrors the sniper's approach: an agent's Solana secret is stored encrypted in
// agent_identities.meta and only decrypted at trade time via the audited
// recoverSolanaAgentKeypair. Cached briefly so a burst of actions for the same
// agent doesn't re-decrypt on every fill.

import { sql } from '../../api/_lib/db.js';
import { recoverSolanaAgentKeypair } from '../../api/_lib/agent-wallet.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // agentId -> { keypair, address, at }

/**
 * Load (and briefly cache) an agent's Solana keypair. Returns null when the
 * agent has no wallet provisioned.
 * @param {string} agentId
 * @param {string|null} userId
 * @param {string} reason  audit reason
 */
export async function loadAgentKeypair(agentId, userId, reason = 'oracle_buy') {
	const hit = cache.get(agentId);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

	const rows = await sql`
		select meta, user_id from agent_identities where id = ${agentId} and deleted_at is null limit 1
	`;
	const row = rows[0];
	if (!row) return null;
	const meta = row.meta || {};
	if (!meta.encrypted_solana_secret) return null;

	const keypair = await recoverSolanaAgentKeypair(meta.encrypted_solana_secret, {
		agentId,
		userId: userId || row.user_id,
		reason,
	});
	const entry = { keypair, address: meta.solana_address || keypair.publicKey?.toBase58?.(), at: Date.now() };
	cache.set(agentId, entry);
	return entry;
}

export function clearKeyCache() { cache.clear(); }

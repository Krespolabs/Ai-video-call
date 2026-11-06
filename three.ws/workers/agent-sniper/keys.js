// agent-sniper — agent keypair loading with an in-process TTL cache.
//
// A long-lived worker would otherwise re-decrypt an agent's Solana secret on
// every trade. We cache the decrypted Keypair for a short TTL keyed by agentId.
// Each *decrypt* still writes a usage_events audit row (via the audit arg to
// recoverSolanaAgentKeypair); cache hits do not, which is correct — no key
// material left the process on a hit. Keypairs are never logged.

import { sql } from '../../api/_lib/db.js';
import { recoverSolanaAgentKeypair } from '../../api/_lib/agent-wallet.js';

const TTL_MS = 5 * 60_000;
const _cache = new Map(); // agentId → { keypair, at }

/**
 * Load the signing Keypair for an agent the sniper already owns a strategy for.
 * Returns null if the agent has no provisioned Solana wallet (the sniper never
 * auto-provisions — an unfunded fresh wallet can't trade anyway).
 *
 * @param {string} agentId
 * @param {string} userId   the strategy owner (for the audit trail)
 * @param {string} reason
 * @returns {Promise<{ keypair: import('@solana/web3.js').Keypair, address: string } | null>}
 */
export async function loadAgentKeypair(agentId, userId, reason = 'sniper_trade') {
	const hit = _cache.get(agentId);
	if (hit && Date.now() - hit.at < TTL_MS) {
		return { keypair: hit.keypair, address: hit.keypair.publicKey.toBase58() };
	}

	const [row] = await sql`
		SELECT meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	const meta = row?.meta || null;
	if (!meta?.encrypted_solana_secret || !meta?.solana_address) return null;

	const keypair = await recoverSolanaAgentKeypair(meta.encrypted_solana_secret, {
		agentId,
		userId,
		reason,
	});
	_cache.set(agentId, { keypair, at: Date.now() });
	return { keypair, address: keypair.publicKey.toBase58() };
}

export function clearKeyCache() {
	_cache.clear();
}

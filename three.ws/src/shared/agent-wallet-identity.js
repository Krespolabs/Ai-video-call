/**
 * Wallet identity — the canonical "agent → wallet descriptor" contract.
 *
 * This is the single normalizer the whole platform shares: the wallet chip, the
 * Wallet HUD/drawer, the vanity studio, and any future wallet surface all derive
 * their data from `getWalletIdentity(agent)` so a given wallet reads identically
 * everywhere. There is exactly one normalizer — it lives in agent-wallet-chip.js
 * (where the chip first established the field-aliasing contract) and is surfaced
 * here under the identity name so new consumers import from a clean, intent-named
 * module instead of reaching into the chip implementation.
 *
 * The descriptor returned by `getWalletIdentity` (and its `getWalletStatus`
 * alias):
 *   {
 *     address, prefix, suffix, isVanity, rarity,   // Solana identity + vanity tier
 *     evmAddress, ownerId, ownerName, forkedFrom,  // multi-chain + ownership
 *     explorerUrl, evmExplorerUrl, hubUrl,         // deep links
 *     galleryUrl, agentId, name, avatarUrl
 *   }
 * or null when the agent has no custodial Solana wallet yet.
 *
 * Live balances, P&L, and reputation are NOT part of the synchronous descriptor —
 * they hydrate from POST /api/agents/balances (real chain state + real value
 * snapshots). Consumers that need them either render a chip (which hydrates
 * itself) or call the batch endpoint directly via `fetchWalletBalances`.
 */

export {
	getWalletIdentity,
	getWalletStatus,
	hasWallet,
	formatWalletUsd,
	walletChipHTML,
	walletChipEl,
	wireWalletChips,
	ensureWalletChipStyles,
} from './agent-wallet-chip.js';

/**
 * Batch-load real wallet balances + 24h P&L for a set of agents in one request.
 * Mirrors the chip's own hydration path so the HUD and the chip never diverge.
 *
 * @param {string[]} agentIds
 * @param {{ network?: 'mainnet'|'devnet' }} [opts]
 * @returns {Promise<Record<string, object>>} agentId → balance descriptor
 *   ({ usd, sol, usdc, three, tokenCount, topHoldings, pnl, isOwner, … }).
 *   Returns {} on any failure — callers render their loading/empty state.
 */
export async function fetchWalletBalances(agentIds, opts = {}) {
	const ids = [...new Set((agentIds || []).filter((x) => typeof x === 'string'))];
	if (ids.length === 0) return {};
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	let apiFetch;
	try { ({ apiFetch } = await import('../api.js')); }
	catch { apiFetch = (p, o) => fetch(p, { credentials: 'include', ...o }); }
	try {
		const res = await apiFetch('/api/agents/balances', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ids: ids.slice(0, 60), network }),
			allowAnonymous: true,
		});
		if (!res.ok) return {};
		const { data } = await res.json();
		return data || {};
	} catch {
		return {};
	}
}

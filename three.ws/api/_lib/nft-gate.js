// NFT-gated skills — "does this wallet hold ≥1 NFT from a given collection?".
//
// Backs the `gate_type = 'nft'` access path in skill-access.js. A creator can
// restrict a skill to holders of a specific Solana NFT collection; access is the
// live, on-chain answer rather than a stored purchase. We resolve it with the
// Helius Digital Asset Standard (DAS) `searchAssets` RPC, which indexes both
// regular (Token Metadata / Metaplex Certified Collection) and compressed
// (Bubblegum) NFTs and lets us filter by `ownerAddress` + collection grouping in
// a single call — so checking "holds one of collection X" costs one request per
// (wallet, collection), with `limit: 1` since presence is all we need.
//
// Fail-closed by contract: every caller treats a thrown error as "no access".
// A gated skill must never be unlocked by an RPC hiccup, so this module throws
// loudly (it never returns a false "true") and the access layer denies on throw.
//
// Env: HELIUS_API_KEY (preferred) or a SOLANA_RPC_URL already pointed at a Helius
// DAS-capable endpoint. DAS is a Helius extension, not a standard Solana RPC
// method, so the generic failover pool in solana/connection.js can't serve it —
// we target Helius directly here.

import { sql } from './db.js';
import { normalizeRpcUrl } from './solana/connection.js';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// DAS calls run inside serverless functions with a hard maxDuration; a hung
// socket must not pin the function open. 8s is generous for an indexed read.
const DAS_TIMEOUT_MS = 8_000;

/** True when `addr` is a syntactically valid base58 Solana address/mint. */
export function isValidSolanaAddress(addr) {
	return typeof addr === 'string' && SOLANA_ADDRESS_RE.test(addr.trim());
}

/**
 * Resolve a Helius DAS-capable RPC URL, or null when none is configured.
 * Prefers the dedicated HELIUS_API_KEY; falls back to SOLANA_RPC_URL only when
 * it already points at a Helius host (the sole provider in our stack exposing
 * the DAS `searchAssets` method).
 */
export function dasRpcUrl() {
	const key = process.env.HELIUS_API_KEY;
	if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
	const configured = normalizeRpcUrl(process.env.SOLANA_RPC_URL || '');
	if (configured && /helius-rpc\.com/i.test(configured)) return configured;
	return null;
}

/** True when NFT gating can be enforced (a DAS endpoint is configured). */
export function nftGateEnabled() {
	return Boolean(dasRpcUrl());
}

/**
 * Raw DAS `searchAssets` call. Exposed for tests via the `fetchImpl` override;
 * production callers use the default global fetch. Throws on transport error,
 * non-200, or a JSON-RPC error envelope so the fail-closed contract holds.
 */
export async function dasSearchAssets(params, { fetchImpl = fetch, rpcUrl = dasRpcUrl() } = {}) {
	if (!rpcUrl) throw new Error('NFT gating requires a Helius DAS RPC endpoint (set HELIUS_API_KEY)');
	const r = await fetchImpl(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 'nft-gate', method: 'searchAssets', params }),
		signal: AbortSignal.timeout(DAS_TIMEOUT_MS),
	});
	if (!r.ok) throw new Error(`das searchAssets ${r.status}`);
	const body = await r.json();
	if (body?.error) throw new Error(`das error ${body.error.code}: ${body.error.message}`);
	return body?.result || { items: [], total: 0 };
}

/**
 * Does `wallet` currently hold at least one NFT grouped under `collectionMint`?
 * One indexed read; throws on any failure (fail-closed).
 *
 * @param {string} wallet          owner base58 address
 * @param {string} collectionMint  collection mint base58 address
 * @param {{ fetchImpl?: Function, rpcUrl?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function walletHoldsCollectionNft(wallet, collectionMint, opts = {}) {
	if (!isValidSolanaAddress(wallet) || !isValidSolanaAddress(collectionMint)) return false;
	const result = await dasSearchAssets(
		{
			ownerAddress: wallet.trim(),
			grouping: ['collection', collectionMint.trim()],
			// Listed/escrowed assets and burns must not count as "held".
			burnt: false,
			page: 1,
			limit: 1,
		},
		opts,
	);
	const items = Array.isArray(result.items) ? result.items : [];
	return items.length > 0;
}

/**
 * Does ANY of `wallets` hold an NFT from `collectionMint`? Resolves to true on
 * the first holding wallet. Throws if every check throws (fail-closed: an
 * all-error result is indistinguishable from "couldn't verify").
 *
 * @param {string[]} wallets
 * @param {string} collectionMint
 * @param {{ fetchImpl?: Function, rpcUrl?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function anyWalletHoldsCollection(wallets, collectionMint, opts = {}) {
	const unique = [...new Set((wallets || []).filter(isValidSolanaAddress))];
	if (unique.length === 0) return false;
	const results = await Promise.allSettled(
		unique.map((w) => walletHoldsCollectionNft(w, collectionMint, opts)),
	);
	if (results.some((r) => r.status === 'fulfilled' && r.value === true)) return true;
	// No wallet held it. If at least one check actually completed, that's a real
	// "false". If every check threw, we genuinely couldn't verify — rethrow so the
	// caller denies access rather than treating an outage as "not a holder".
	if (results.every((r) => r.status === 'rejected')) {
		throw results[0].reason || new Error('all NFT ownership checks failed');
	}
	return false;
}

/**
 * The Solana wallet addresses linked to a user, across both the canonical
 * `users.wallet_address` (their primary login wallet) and any additional
 * `user_wallets` rows of chain_type 'solana'. Deduped. Empty when none.
 *
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
export async function getUserSolanaWallets(userId) {
	if (!userId) return [];
	const rows = await sql`
		SELECT address FROM user_wallets
		WHERE user_id = ${userId} AND chain_type = 'solana' AND address IS NOT NULL
		UNION
		SELECT wallet_address AS address FROM users
		WHERE id = ${userId} AND wallet_address IS NOT NULL
	`.catch(() => []);
	return [...new Set(rows.map((r) => r.address).filter(isValidSolanaAddress))];
}

/**
 * Does `userId` hold an NFT from `collectionMint` in any linked Solana wallet?
 * Throws on RPC failure (fail-closed). Returns false when the user has no linked
 * Solana wallet — there is nothing to check against.
 *
 * @param {string} userId
 * @param {string} collectionMint
 * @param {{ fetchImpl?: Function, rpcUrl?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function userHoldsCollection(userId, collectionMint, opts = {}) {
	const wallets = await getUserSolanaWallets(userId);
	if (wallets.length === 0) return false;
	return anyWalletHoldsCollection(wallets, collectionMint, opts);
}

/**
 * For a set of active price rows, return the skill names an NFT gate currently
 * grants the viewer — so a display surface can mark them "owned" alongside
 * purchased skills. This is for DISPLAY only and is fail-SOFT: a verification
 * error simply omits the skill (the viewer sees the gate, not an error). The
 * authoritative, fail-closed decision lives in hasSkillAccess() on execution.
 *
 * Resolves the viewer's wallets once and checks each distinct collection a
 * single time (skills sharing a collection cost one check).
 *
 * @param {Array<{ skill: string, gate_type?: string, nft_collection_mint?: string }>} priceRows
 * @param {string|null} userId
 * @param {{ fetchImpl?: Function, rpcUrl?: string }} [opts]
 * @returns {Promise<string[]>} skill names the viewer can use via an NFT gate
 */
export async function viewerNftGatedSkills(priceRows, userId, opts = {}) {
	if (!userId || !nftGateEnabled()) return [];
	const gated = (priceRows || []).filter(
		(r) => r.gate_type === 'nft' && r.nft_collection_mint,
	);
	if (gated.length === 0) return [];

	const wallets = await getUserSolanaWallets(userId);
	if (wallets.length === 0) return [];

	const collections = [...new Set(gated.map((r) => r.nft_collection_mint))];
	const heldByCollection = new Map();
	await Promise.all(
		collections.map(async (mint) => {
			try {
				heldByCollection.set(mint, await anyWalletHoldsCollection(wallets, mint, opts));
			} catch {
				heldByCollection.set(mint, false); // fail-soft for display
			}
		}),
	);

	return gated
		.filter((r) => heldByCollection.get(r.nft_collection_mint) === true)
		.map((r) => r.skill);
}

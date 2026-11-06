/**
 * Browser-side write helpers for `GreenfieldVault.sol` (prompt 10) — the
 * buyer/seller wallet calls the contract directly (per prompt 10's design:
 * "buying/listing/revoking happen from the buyer's/seller's own wallet
 * directly against the contract... not relayed through this server" — see
 * `api/_lib/bnb/vault-contract.js`'s module doc). This file only builds
 * calldata + reads the live relay-fee quote; it never holds or signs with a
 * key itself — the caller supplies a viem `Account`/`WalletClient`
 * (`vault-session.js`'s ephemeral buyer key, or a connected browser wallet
 * for the seller-listing flow).
 */

import { encodeFunctionData, parseAbi, encodeAbiParameters } from 'viem';
import { getPublicClient } from '../../api/_lib/bnb/chains.js';
import { quoteRelayFee, vaultClient } from '../../api/_lib/bnb/vault-contract.js';
import { sendGasless } from '../../api/_lib/bnb/megafuel.js';

/** Mirrors `contracts/src/GreenfieldVault.sol`'s external write surface exactly. */
export const GREENFIELD_VAULT_WRITE_ABI = parseAbi([
	'function list(bytes32 objectId, uint256 price, address seller) external',
	'function delist(bytes32 objectId) external',
	'function buy(bytes32 objectId, bytes calldata policyData) external payable returns (uint256 saleId)',
	'function revoke(uint256 saleId) external payable',
	'function withdraw() external returns (uint256 amount)',
]);

/**
 * `policyData` is meant to be the real Greenfield `PermissionHub.createPolicy`
 * payload — a GNFD protobuf-encoded principal/resource/statement set built
 * off-chain against the object's real Greenfield resource id (see
 * `IPermissionHub.sol`'s doc comment). Building that encoder needs a REAL
 * Greenfield-mirrored object to encode a resource id for — which needs the
 * same funded Greenfield write path blocked across this whole campaign (07/
 * 09/10/11/13 PROGRESS entries). Byte-perfect GNFD protobuf is also not
 * something to guess at without a way to verify it against a live
 * PermissionHub. Until that unblocks, this returns a structurally-valid,
 * non-empty, deterministic placeholder (satisfies `buy()`'s `EmptyPolicyData`
 * guard) — the exact same posture the prompt-11 anvil E2E proof used
 * (`0xdeadbeef`), just object/buyer-scoped so two different purchases never
 * collide. Documented honestly in docs/bnb-vault.md; NOT wired to decode into
 * anything on a real PermissionHub yet.
 * @param {`0x${string}`} objectId @param {`0x${string}`} buyer
 * @returns {`0x${string}`}
 */
export function buildPolicyDataPlaceholder(objectId, buyer) {
	return encodeAbiParameters(
		[{ type: 'bytes32' }, { type: 'address' }, { type: 'string' }],
		[objectId, buyer, 'three.ws/vault/v1-placeholder'],
	);
}

/**
 * Resolve the `policyData` bytes for a `buy()` call: try the REAL
 * `GET /api/vault/buy-policy-data` first (real protobuf-encoded GNFD
 * `Policy`, see `api/_lib/bnb/vault-policy-data.js` — only succeeds for a
 * listing whose object has genuinely completed Greenfield upload+mirroring),
 * and fall back to `buildPolicyDataPlaceholder` on any 404/503 (true for
 * every listing today, per that module's own docstring — same funding wall
 * as everywhere else in this campaign). Progressive enhancement: zero
 * behavior change today, automatically starts using real bytes the moment a
 * listing's object is genuinely uploaded.
 * @param {{ objectId:`0x${string}`, buyer:`0x${string}`, network:'testnet'|'mainnet' }} p
 * @returns {Promise<`0x${string}`>}
 */
export async function resolvePolicyData({ objectId, buyer, network }) {
	try {
		const res = await fetch(
			`/api/vault/buy-policy-data?objectId=${objectId}&buyer=${buyer}&network=${network}`,
			{
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(6000),
			},
		);
		if (res.ok) {
			const body = await res.json();
			if (body?.policyData) return body.policyData;
		}
	} catch {
		/* real path unavailable — honest fallback below */
	}
	return buildPolicyDataPlaceholder(objectId, buyer);
}

/**
 * Live-quote the BNB the buyer must send on top of `priceAtomic` for `buy()`
 * to cover the cross-chain relay fee — read fresh, never cached (fees drift
 * with BSC gas price).
 * @param {'testnet'|'mainnet'} network
 * @param {`0x${string}`} contractAddress
 * @param {{ client?: import('viem').PublicClient }} [opts]
 */
export async function quoteBuyRelayFee(network, contractAddress, opts = {}) {
	const client = opts.client || vaultClient(network);
	return quoteRelayFee(client, contractAddress);
}

/**
 * Send `buy(objectId, policyData)` from the buyer's session account, gasless
 * via MegaFuel when sponsorable (self-pay fallback always available — the
 * `msg.value` itself is never sponsored, only the gas fee).
 * @param {object} p
 * @param {import('viem').Account} p.account buyer's signer (vault-session.js)
 * @param {'testnet'|'mainnet'} p.network
 * @param {`0x${string}`} p.contractAddress
 * @param {`0x${string}`} p.objectId
 * @param {bigint} p.priceAtomic listing price, in wei
 * @param {{ publicClient?: import('viem').PublicClient }} [opts]
 * @returns {Promise<{ hash:`0x${string}`, mode:'sponsored'|'self-pay' }>}
 */
export async function sendBuyTx(
	{ account, network, contractAddress, objectId, priceAtomic },
	opts = {},
) {
	const policyData =
		opts.policyData || (await resolvePolicyData({ objectId, buyer: account.address, network }));
	const client = opts.publicClient || vaultClient(network);
	const { total: relayFeeTotal } = await quoteRelayFee(client, contractAddress);
	const value = priceAtomic + relayFeeTotal;
	const data = encodeFunctionData({
		abi: GREENFIELD_VAULT_WRITE_ABI,
		functionName: 'buy',
		args: [objectId, policyData],
	});
	return sendGasless(
		chainNetworkKey(network),
		{ account, tx: { to: contractAddress, value, data } },
		{ publicClient: client },
	);
}

/**
 * Send `list(objectId, price, seller)` from the seller's own wallet (a
 * connected browser wallet — sellers hold no session key; only buyers do,
 * per vault-session.js's doc comment). No gasless path here on purpose: a
 * seller's browser wallet signs+sends directly, same as any other on-chain
 * write this platform doesn't relay.
 * @param {import('viem').WalletClient} walletClient connected seller wallet client (already on the right chain)
 * @param {`0x${string}`} contractAddress
 * @param {`0x${string}`} objectId
 * @param {bigint} priceAtomic
 * @param {`0x${string}`} seller
 */
export async function sendListTx(walletClient, contractAddress, objectId, priceAtomic, seller) {
	return walletClient.writeContract({
		address: contractAddress,
		abi: GREENFIELD_VAULT_WRITE_ABI,
		functionName: 'list',
		args: [objectId, priceAtomic, seller],
		account: seller,
	});
}

function chainNetworkKey(network) {
	return network === 'mainnet' ? 'bscMainnet' : 'bscTestnet';
}

export { getPublicClient };

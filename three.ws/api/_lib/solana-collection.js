/**
 * three.ws Agent Collection — our "flavor" of Metaplex Core on Solana.
 * ------------------------------------------------------------------------
 * Every agent deployed to Solana is minted as a Metaplex Core *asset inside a
 * three.ws Collection account*. The Collection is the on-chain artifact that is
 * unmistakably ours: it carries the three.ws brand, the standard agent plugin
 * schema, and — crucially — its update authority is a three.ws-held keypair.
 *
 * Because the asset's update authority resolves to the Collection (and the
 * Collection's update authority is three.ws), three.ws can edit the on-chain
 * Attributes / name / URI of any member agent without the owner re-signing.
 * This is the "three.ws authority-managed" edit model: the user owns the asset
 * (can transfer/sell it), three.ws curates its on-chain metadata on request.
 *
 * Activation is progressive and safe:
 *   • If no collection address is configured for a network, callers fall back
 *     to the legacy standalone-asset mint (owner = update authority). Nothing
 *     breaks before the collection is deployed.
 *   • Once `SOLANA_AGENT_COLLECTION_<NET>` is set (see scripts/
 *     deploy-solana-agent-collection.mjs), new mints join the collection and
 *     become authority-managed.
 *
 * Authority key handling mirrors api/_lib/attest-event.js: a base58-encoded
 * Ed25519 secret in the environment, decoded on demand. It is never logged and
 * never leaves the server.
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createSignerFromKeypair } from '@metaplex-foundation/umi';

import { THREE_WS } from './three-brand.js';

/** Networks we support for agent collections. */
export const COLLECTION_NETWORKS = /** @type {const} */ (['mainnet', 'devnet']);

/**
 * Deployed three.ws Agent Collection address for a network, or null if the
 * collection has not been deployed/configured yet (legacy standalone mints).
 *
 * @param {'mainnet'|'devnet'} network
 * @returns {string|null} base58 collection pubkey
 */
export function getAgentCollection(network) {
	const key =
		network === 'devnet'
			? 'SOLANA_AGENT_COLLECTION_DEVNET'
			: 'SOLANA_AGENT_COLLECTION_MAINNET';
	const v = process.env[key];
	return v && v.trim() ? v.trim() : null;
}

/** True when a three.ws collection is configured for the network. */
export function hasAgentCollection(network) {
	return getAgentCollection(network) !== null;
}

/**
 * Decode the three.ws collection-authority secret into a web3.js Keypair.
 * This keypair is the update authority of the Collection (and therefore of
 * every member agent). It signs collection creation, mint-into-collection, and
 * all on-chain edits, and pays the fee for server-initiated edits — so it must
 * hold a small SOL balance on each active network.
 *
 * @returns {Keypair}
 */
export function loadCollectionAuthorityKeypair() {
	const k = process.env.SOLANA_AGENT_COLLECTION_AUTHORITY_KEY;
	if (!k) {
		throw Object.assign(
			new Error(
				'SOLANA_AGENT_COLLECTION_AUTHORITY_KEY not configured — required to mint into or edit the three.ws agent collection.',
			),
			{ status: 500, code: 'authority_unconfigured' },
		);
	}
	return Keypair.fromSecretKey(bs58.decode(k));
}

/** Public base58 address of the collection authority, without exposing the secret. */
export function collectionAuthorityAddress() {
	return loadCollectionAuthorityKeypair().publicKey.toBase58();
}

/**
 * Build a Umi signer for the collection authority, bound to the given Umi
 * instance. Use this as the `authority` when creating assets into the
 * collection or when editing member assets server-side.
 *
 * @param {import('@metaplex-foundation/umi').Umi} umi
 * @returns {import('@metaplex-foundation/umi').Signer}
 */
export function collectionAuthoritySigner(umi) {
	const kp = loadCollectionAuthorityKeypair();
	const umiKeypair = umi.eddsa.createKeypairFromSecretKey(kp.secretKey);
	return createSignerFromKeypair(umi, umiKeypair);
}

/**
 * On-chain metadata for the Collection account itself. Mirrors the per-agent
 * brand block so a wallet/explorer viewing the collection sees three.ws.
 */
export const AGENT_COLLECTION = {
	name: 'three.ws Agents',
	// Resolvable JSON describing the collection (served by the API; see the
	// deploy script). Standard Metaplex collection metadata so Phantom / Solscan
	// / Magic Eden render it as a real collection.
	metadataPath: '/api/agents/solana-collection-metadata',
	description:
		'On-chain identities for autonomous agents built on three.ws — each asset ' +
		'is a deployable AI agent with a 3D avatar, editable on-chain metadata, ' +
		'pay-per-call (x402), and a link back to its three.ws profile.',
	website: THREE_WS.website,
};

/**
 * Skill-ownership NFT minting — the on-chain receipt + perpetual license a
 * buyer receives after a confirmed skill purchase.
 * ---------------------------------------------------------------------------
 * Each agent owns a per-agent Metaplex Core *collection* (the master identifier
 * for every skill NFT sold by that agent — see
 * migrations/20260617120000_agent_skill_collection.sql). Every purchased skill
 * is minted as a Core asset *inside* that collection, owned by the buyer's
 * wallet, signed + paid by the three.ws collection-authority keypair.
 *
 * Two reasons this lives in its own module rather than inline in the endpoint:
 *   1. It pulls in @metaplex-foundation/mpl-core + @solana/web3.js — heavy deps
 *      we keep off the import graph of endpoints that don't mint.
 *   2. The collection is created lazily on the agent's first skill sale, so the
 *      create-then-mint sequence (and its race handling) is shared logic.
 *
 * Metaplex Core specifics that simplify the flow vs. the legacy Token-Metadata
 * path: minting an asset with `collection` + the collection's update authority
 * as signer verifies the asset into the collection *at creation time* — there
 * is no separate verifyCollection transaction to run afterwards.
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
	mplCore,
	create,
	createCollection,
	fetchCollection,
} from '@metaplex-foundation/mpl-core';
import {
	generateSigner,
	publicKey as umiPublicKey,
	signerIdentity,
} from '@metaplex-foundation/umi';
import bs58 from 'bs58';

import { sql } from './db.js';
import { env } from './env.js';
import { collectionAuthoritySigner } from './solana-collection.js';
import { solanaConnection } from './solana/connection.js';
import { skillCollectionSymbol } from './three-brand.js';

/** Skill-NFT networks we support. Mainnet is the default (live purchases). */
export const SKILL_NFT_NETWORKS = /** @type {const} */ (['mainnet', 'devnet']);

/**
 * Resolve the minting network. Solana skill purchases settle on mainnet, so
 * that's the default; `SKILL_NFT_NETWORK=devnet` lets an operator point new
 * mints at devnet (e.g. while funding the mainnet authority wallet) without a
 * code change. An agent that already has a collection on one network stays on
 * that network — collection and asset must live on the same cluster.
 *
 * @param {{ existingNetwork?: string|null, preferred?: string|null }} [opts]
 * @returns {'mainnet'|'devnet'}
 */
export function resolveSkillNftNetwork({ existingNetwork = null, preferred = null } = {}) {
	if (existingNetwork === 'mainnet' || existingNetwork === 'devnet') return existingNetwork;
	if (preferred === 'mainnet' || preferred === 'devnet') return preferred;
	const env_ = (process.env.SKILL_NFT_NETWORK || '').trim();
	if (env_ === 'devnet') return 'devnet';
	return 'mainnet';
}

function rpcForNetwork(network) {
	return network === 'devnet' ? env.SOLANA_RPC_URL_DEVNET : env.SOLANA_RPC_URL;
}

function collectionMetadataUri(agentId, network) {
	return `${env.APP_ORIGIN}/api/agents/solana/skill-collection-metadata?agent=${agentId}&network=${network}`;
}

function skillNftMetadataUri(agentId, skill, network) {
	return (
		`${env.APP_ORIGIN}/api/agents/solana/skill-nft-metadata` +
		`?agent=${agentId}&skill=${encodeURIComponent(skill)}&network=${network}`
	);
}

function explorerUrl(mint, network) {
	const cluster = network === 'devnet' ? '?cluster=devnet' : '';
	return `https://solscan.io/token/${mint}${cluster}`;
}

/**
 * Build a Umi instance whose identity is the three.ws collection authority —
 * the fee payer and signer for collection creation and every mint-into-collection.
 */
function authorityUmi(network) {
	// Failover Connection rather than a bare URL: collection creation and every
	// mint-into-collection rotate across the endpoint chain, so a single node's
	// malformed/empty 200 body fails over instead of throwing the StructError crash.
	const umi = createUmi(solanaConnection({ url: rpcForNetwork(network), network })).use(mplCore());
	const authority = collectionAuthoritySigner(umi);
	umi.use(signerIdentity(authority));
	return { umi, authority };
}

/**
 * Ensure the agent has a per-agent skill collection, creating it on first use.
 * Returns the collection mint (base58) and the network it lives on.
 *
 * Concurrency: two simultaneous first-purchase mints could each create a
 * collection. We claim the address with a conditional UPDATE guarded on
 * `skill_collection_mint IS NULL`; the loser detects the race, keeps the
 * winner's collection, and logs the orphaned one (harmless — it just isn't
 * referenced). This trades a rare, bounded extra rent payment for never
 * blocking a sale on a lock.
 *
 * @param {object} p
 * @param {import('@metaplex-foundation/umi').Umi} p.umi
 * @param {string} p.agentId
 * @param {string} p.agentName
 * @param {'mainnet'|'devnet'} p.network
 * @param {string|null} [p.existingMint]
 * @returns {Promise<string>} collection mint (base58)
 */
async function ensureAgentSkillCollection({ umi, agentId, agentName, network, existingMint }) {
	if (existingMint) return existingMint;

	const collectionSigner = generateSigner(umi);
	const uri = collectionMetadataUri(agentId, network);

	const { signature } = await create_collection_tx({
		umi,
		collectionSigner,
		agentName,
		uri,
		network,
	});

	const mint = collectionSigner.publicKey.toString();
	const [claimed] = await sql`
		UPDATE agent_identities
		SET skill_collection_mint       = ${mint},
		    skill_collection_network     = ${network},
		    skill_collection_uri         = ${uri},
		    skill_collection_tx          = ${signature},
		    skill_collection_created_at  = now()
		WHERE id = ${agentId} AND skill_collection_mint IS NULL
		RETURNING skill_collection_mint
	`;
	if (claimed?.skill_collection_mint) return claimed.skill_collection_mint;

	// Lost the race — another mint created the collection first. Use theirs.
	const [winner] = await sql`
		SELECT skill_collection_mint FROM agent_identities WHERE id = ${agentId}
	`;
	console.warn('[skill-nft] collection create raced; orphaned collection', {
		agentId,
		orphan: mint,
		kept: winner?.skill_collection_mint,
	});
	return winner?.skill_collection_mint || mint;
}

// Split out so the on-chain call is a single named unit (and easy to read).
async function create_collection_tx({ umi, collectionSigner, agentName, uri, network }) {
	const { signature } = await createCollection(umi, {
		collection: collectionSigner,
		name: `${agentName} — Skills`,
		uri,
		plugins: [
			{
				type: 'Attributes',
				attributeList: [
					{ key: 'platform', value: 'three.ws' },
					{ key: 'kind', value: 'skill-collection' },
					{ key: 'symbol', value: skillCollectionSymbol(agentName) },
					{ key: 'network', value: network },
				],
			},
		],
	}).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });
	return { signature: encodeSignature(signature) };
}

// Umi returns transaction signatures as a Uint8Array; render the base58 string
// that explorers + the rest of our pipeline expect.
function encodeSignature(sig) {
	return typeof sig === 'string' ? sig : bs58.encode(sig);
}

/**
 * Mint a skill-ownership NFT to the buyer's wallet from the agent's skill
 * collection. Creates the collection on first use.
 *
 * @param {object} p
 * @param {string} p.agentId
 * @param {string} p.skill        — skill name/slug being purchased
 * @param {string} p.ownerWallet  — buyer's base58 Solana pubkey (NFT recipient)
 * @param {string|null} [p.preferredNetwork]
 * @returns {Promise<{ mint: string, signature: string, collection: string,
 *                     network: 'mainnet'|'devnet', uri: string, explorer: string }>}
 */
export async function mintSkillNft({ agentId, skill, ownerWallet, preferredNetwork = null }) {
	const [agent] = await sql`
		SELECT name, skill_collection_mint, skill_collection_network
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) {
		throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });
	}

	const network = resolveSkillNftNetwork({
		existingNetwork: agent.skill_collection_network,
		preferred: preferredNetwork,
	});

	let ownerPk;
	try {
		ownerPk = umiPublicKey(ownerWallet);
	} catch {
		throw Object.assign(new Error('invalid owner wallet'), {
			status: 400,
			code: 'validation_error',
		});
	}

	const { umi, authority } = authorityUmi(network);

	const collectionMint = await ensureAgentSkillCollection({
		umi,
		agentId,
		agentName: agent.name,
		network,
		existingMint: agent.skill_collection_mint,
	});

	const collection = await fetchCollection(umi, umiPublicKey(collectionMint));

	const assetSigner = generateSigner(umi);
	const uri = skillNftMetadataUri(agentId, skill, network);

	const { signature } = await create(umi, {
		asset: assetSigner,
		collection,
		// Authority that signs the asset INTO the collection — three.ws holds the
		// collection update authority, so the asset is collection-verified on mint.
		authority,
		owner: ownerPk,
		name: `${agent.name}: ${skill}`,
		uri,
		plugins: [
			{
				type: 'Attributes',
				attributeList: [
					{ key: 'kind', value: 'skill-license' },
					{ key: 'agent_id', value: agentId },
					{ key: 'skill', value: String(skill) },
					{ key: 'platform', value: 'three.ws' },
				],
			},
		],
	}).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });

	const mint = assetSigner.publicKey.toString();
	return {
		mint,
		signature: encodeSignature(signature),
		collection: collectionMint,
		network,
		uri,
		explorer: explorerUrl(mint, network),
	};
}

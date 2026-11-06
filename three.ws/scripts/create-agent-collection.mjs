#!/usr/bin/env node
/**
 * Create a per-agent skill NFT collection on Solana (Metaplex Core).
 * ------------------------------------------------------------------------
 * Each agent gets its OWN Core Collection account that serves as the master
 * identifier for every "skill ownership" NFT minted to users who purchase that
 * agent's skills. Holding a verified asset inside this collection proves a user
 * paid for a skill — the collection is the on-chain anchor that authenticates
 * the whole set and lets a verifier resolve the agent from any member NFT.
 *
 * This is distinct from the platform-wide "three.ws Agents" collection
 * (scripts/deploy-solana-agent-collection.mjs) which groups the agent identity
 * assets themselves. This script creates one collection per agent for skills.
 *
 * The collection's update authority is the three.ws collection-authority
 * keypair, so the platform can later mint skill NFTs into the collection on a
 * buyer's behalf without the agent owner re-signing.
 *
 * Usage:
 *   # devnet (default — safe, free), single agent:
 *   SOLANA_AGENT_COLLECTION_AUTHORITY_KEY=<bs58 secret> \
 *   DATABASE_URL=<postgres> \
 *     node scripts/create-agent-collection.mjs --agent <agent-uuid>
 *
 *   # backfill every agent that lacks a skill collection:
 *     node scripts/create-agent-collection.mjs --all [--limit 50]
 *
 *   # preview without touching the chain or DB:
 *     node scripts/create-agent-collection.mjs --agent <uuid> --dry-run
 *
 *   # re-create even if the agent already has one (old address is overwritten):
 *     node scripts/create-agent-collection.mjs --agent <uuid> --force
 *
 *   # mainnet (irreversible, costs real SOL — explicit double opt-in required):
 *   SOLANA_AGENT_COLLECTION_AUTHORITY_KEY=<bs58 secret> \
 *   SOLANA_RPC_URL=<mainnet rpc with api key> \
 *   DATABASE_URL=<postgres> \
 *   CONFIRM_MAINNET_DEPLOY=yes \
 *     node scripts/create-agent-collection.mjs --agent <uuid> --network mainnet
 *
 * Prereqs: the authority keypair must hold SOL on the target network
 * (collection rent ~0.003 SOL + fee per agent). On devnet you can airdrop; on
 * mainnet fund it first. Re-running is safe: agents that already have a skill
 * collection are skipped unless --force is passed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, createCollection, fetchCollection } from '@metaplex-foundation/mpl-core';
import { createSignerFromKeypair, generateSigner, signerIdentity } from '@metaplex-foundation/umi';

import { skillCollectionSymbol, THREE_WS } from '../api/_lib/three-brand.js';

// Neon's Pool is pg-compatible and supports parameterized text queries — the
// same driver scripts/apply-migrations.mjs uses for script-side DB access.
neonConfig.webSocketConstructor = ws;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const PUBLIC_RPC = {
	mainnet: 'https://api.mainnet-beta.solana.com',
	devnet: 'https://api.devnet.solana.com',
};

// ── env / args ────────────────────────────────────────────────────────────────

// Load .env.local / .env so the script is runnable without exporting vars first
// (same pattern as scripts/apply-migrations.mjs). Real env always wins.
for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
	} catch {
		/* file absent — fine */
	}
}

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
	return process.argv.includes(name);
}

const NETWORK = arg('--network') === 'mainnet' ? 'mainnet' : 'devnet';
const DRY_RUN = flag('--dry-run');
const FORCE = flag('--force');
const ALL = flag('--all');
const LIMIT = Number(arg('--limit') || 0);
const AGENT_ID = arg('--agent');

function fail(msg) {
	console.error(`\n❌ ${msg}`);
	process.exit(1);
}

function maskRpc(rpc) {
	return rpc.replace(/api-key=[^&]+/i, 'api-key=***');
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
	if (!AGENT_ID && !ALL) {
		fail('Pass --agent <agent-uuid> for one agent, or --all to backfill every agent.');
	}
	if (AGENT_ID && !/^[0-9a-f-]{36}$/i.test(AGENT_ID)) {
		fail(`--agent must be a uuid, got: ${AGENT_ID}`);
	}
	if (NETWORK === 'mainnet' && !DRY_RUN && process.env.CONFIRM_MAINNET_DEPLOY !== 'yes') {
		fail(
			'Refusing mainnet creation without CONFIRM_MAINNET_DEPLOY=yes.\n' +
				'Mainnet collection creation is irreversible and costs real SOL.',
		);
	}

	const secret = process.env.SOLANA_AGENT_COLLECTION_AUTHORITY_KEY;
	if (!secret) fail('SOLANA_AGENT_COLLECTION_AUTHORITY_KEY (bs58 secret) is required.');

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) fail('DATABASE_URL is required.');

	const rpc =
		NETWORK === 'devnet'
			? process.env.SOLANA_RPC_URL_DEVNET || PUBLIC_RPC.devnet
			: process.env.SOLANA_RPC_URL || PUBLIC_RPC.mainnet;

	const appOrigin = process.env.APP_ORIGIN || THREE_WS.website;

	// ── Umi + authority ──────────────────────────────────────────────────────
	const umi = createUmi(rpc).use(mplCore());
	const web3Authority = Keypair.fromSecretKey(bs58.decode(secret));
	const authority = createSignerFromKeypair(
		umi,
		umi.eddsa.createKeypairFromSecretKey(web3Authority.secretKey),
	);
	umi.use(signerIdentity(authority));

	console.log(`Network:    ${NETWORK}`);
	console.log(`RPC:        ${maskRpc(rpc)}`);
	console.log(`Authority:  ${authority.publicKey}`);
	console.log(`App origin: ${appOrigin}`);
	console.log(`Mode:       ${ALL ? 'backfill all' : `single agent ${AGENT_ID}`}${FORCE ? ' (force)' : ''}${DRY_RUN ? ' [dry-run]' : ''}`);
	console.log('');

	// ── Load target agents ─────────────────────────────────────────────────────
	const db = new Pool({ connectionString: databaseUrl });

	let agents;
	try {
		if (ALL) {
			const { rows } = await db.query(
				`SELECT id, name, skill_collection_mint
				   FROM agent_identities
				  WHERE deleted_at IS NULL
				    ${FORCE ? '' : 'AND skill_collection_mint IS NULL'}
				  ORDER BY created_at ASC
				  ${LIMIT ? `LIMIT ${LIMIT}` : ''}`,
			);
			agents = rows;
		} else {
			const { rows } = await db.query(
				`SELECT id, name, skill_collection_mint
				   FROM agent_identities
				  WHERE id = $1 AND deleted_at IS NULL
				  LIMIT 1`,
				[AGENT_ID],
			);
			if (rows.length === 0) {
				fail(`Agent ${AGENT_ID} not found (or deleted).`);
			}
			agents = rows;
		}

		if (agents.length === 0) {
			console.log('No agents need a skill collection. Nothing to do.');
			return;
		}

		console.log(`${agents.length} agent(s) to process.\n`);

		let created = 0, skipped = 0, failed = 0;

		for (const agent of agents) {
			const label = `${agent.name} (${agent.id})`;

			if (agent.skill_collection_mint && !FORCE) {
				console.log(`⏭  skip   ${label} — already has ${agent.skill_collection_mint}`);
				skipped++;
				continue;
			}

			const name = `${agent.name} — Skills`;
			const symbol = skillCollectionSymbol(agent.name);
			const uri = `${appOrigin}/api/agents/solana-skill-collection-metadata?agent=${agent.id}&network=${NETWORK}`;

			if (DRY_RUN) {
				console.log(`🔎 plan   ${label}`);
				console.log(`          name:   ${name}`);
				console.log(`          symbol: ${symbol}`);
				console.log(`          uri:    ${uri}`);
				created++;
				continue;
			}

			try {
				const collectionSigner = generateSigner(umi);

				const { signature } = await createCollection(umi, {
					collection: collectionSigner,
					name,
					uri,
					plugins: [
						{
							type: 'Attributes',
							attributeList: [
								{ key: 'platform', value: THREE_WS.name },
								{ key: 'kind', value: 'agent-skill-collection' },
								{ key: 'agent_id', value: agent.id },
								{ key: 'symbol', value: symbol },
								{ key: 'standard', value: 'metaplex-core' },
								{ key: 'chain', value: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
							],
						},
					],
				}).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });

				// Confirm the collection landed before we trust the address.
				await fetchCollection(umi, collectionSigner.publicKey);

				const mint = collectionSigner.publicKey.toString();
				const txSig = signature ? bs58.encode(signature) : null;

				await db.query(
					`UPDATE agent_identities
					    SET skill_collection_mint       = $1,
					        skill_collection_network    = $2,
					        skill_collection_uri        = $3,
					        skill_collection_tx         = $4,
					        skill_collection_created_at  = now(),
					        updated_at                   = now()
					  WHERE id = $5`,
					[mint, NETWORK, uri, txSig, agent.id],
				);

				console.log(`✅ create ${label}`);
				console.log(`          collection: ${mint}`);
				created++;
			} catch (err) {
				console.error(`❌ fail   ${label} — ${err?.message || err}`);
				failed++;
			}
		}

		console.log(`\nDone. created/planned: ${created}, skipped: ${skipped}, failed: ${failed}`);
		if (failed > 0) process.exitCode = 1;
	} finally {
		await db.end();
	}
}

main().catch((err) => {
	console.error('\n❌ create-agent-collection failed:', err?.message || err);
	process.exit(1);
});

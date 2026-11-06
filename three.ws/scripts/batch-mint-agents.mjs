#!/usr/bin/env node
/**
 * Batch-mint all three.ws agents with 3D avatars as Metaplex Core assets.
 * -------------------------------------------------------------------------
 * Iterates every agent_identity that has an avatar but no sol_mint_address,
 * mints it into the three.ws Agent Collection on Solana, and writes the
 * resulting asset address back to the DB.
 *
 * Custody model:
 *   - If the agent's user has a Solana payout wallet → mint directly to them.
 *   - Otherwise → mint to the collection authority as custodian.
 *     The authority (as owner) can transfer to the user when they connect
 *     their Solana wallet via the claim flow.
 *
 * Usage:
 *   # Required env vars:
 *   SOLANA_AGENT_COLLECTION_AUTHORITY_KEY=<bs58 secret>
 *   SOLANA_AGENT_COLLECTION_MAINNET=<collection address>
 *   DATABASE_URL=<postgres connection string>
 *   S3_BUCKET=<bucket>
 *   S3_PUBLIC_DOMAIN=<https://...>
 *   AWS_ACCESS_KEY_ID=<key>
 *   AWS_SECRET_ACCESS_KEY=<secret>
 *   AWS_ENDPOINT_URL_S3=<r2 endpoint>
 *
 *   # Run (devnet safe test first):
 *   node scripts/batch-mint-agents.mjs --network devnet --dry-run
 *
 *   # Real mainnet run:
 *   SOLANA_RPC_URL=<rpc> node scripts/batch-mint-agents.mjs --network mainnet
 *
 *   # Limit to N agents (useful for staged rollouts):
 *   node scripts/batch-mint-agents.mjs --network mainnet --limit 50
 *
 *   # Re-run is safe — already-minted agents are skipped.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, create, ruleSet } from '@metaplex-foundation/mpl-core';
import {
	generateSigner,
	publicKey as umiPublicKey,
	createSignerFromKeypair,
	signerIdentity,
} from '@metaplex-foundation/umi';

// ── CLI args ─────────────────────────────────────────────────────────────────

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
	return process.argv.includes(name);
}

const NETWORK = arg('--network') === 'mainnet' ? 'mainnet' : 'devnet';
const DRY_RUN = flag('--dry-run');
const LIMIT   = Number(arg('--limit') || 0);

const PUBLIC_RPC = {
	mainnet: 'https://api.mainnet-beta.solana.com',
	devnet:  'https://api.devnet.solana.com',
};

// ── Env validation ────────────────────────────────────────────────────────────

function required(key) {
	const v = process.env[key];
	if (!v || !v.trim()) {
		console.error(`Missing required env var: ${key}`);
		process.exit(1);
	}
	return v.trim();
}

const AUTHORITY_KEY = required('SOLANA_AGENT_COLLECTION_AUTHORITY_KEY');
const COLLECTION_ADDR =
	NETWORK === 'mainnet'
		? required('SOLANA_AGENT_COLLECTION_MAINNET')
		: required('SOLANA_AGENT_COLLECTION_DEVNET');
const DATABASE_URL = required('DATABASE_URL');
const S3_BUCKET    = required('S3_BUCKET');
const S3_DOMAIN    = required('S3_PUBLIC_DOMAIN');

// ── R2 client ─────────────────────────────────────────────────────────────────

const s3 = new S3Client({
	region: 'auto',
	endpoint: process.env.AWS_ENDPOINT_URL_S3,
	credentials: {
		accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
	},
});

function publicUrl(key) {
	return `${S3_DOMAIN}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function uploadJson(key, obj) {
	const body = Buffer.from(JSON.stringify(obj), 'utf-8');
	await s3.send(new PutObjectCommand({
		Bucket: S3_BUCKET, Key: key, Body: body, ContentType: 'application/json',
	}));
	return publicUrl(key);
}

// ── Umi / Metaplex setup ──────────────────────────────────────────────────────

const rpc =
	NETWORK === 'devnet'
		? process.env.SOLANA_RPC_URL_DEVNET || PUBLIC_RPC.devnet
		: process.env.SOLANA_RPC_URL        || PUBLIC_RPC.mainnet;

const umi = createUmi(rpc).use(mplCore());
const web3Authority = Keypair.fromSecretKey(bs58.decode(AUTHORITY_KEY));
const authoritySigner = createSignerFromKeypair(
	umi,
	umi.eddsa.createKeypairFromSecretKey(web3Authority.secretKey),
);
umi.use(signerIdentity(authoritySigner));

const authorityPk  = authoritySigner.publicKey.toString();
const collectionPk = umiPublicKey(COLLECTION_ADDR);

// ── Manifest builder ──────────────────────────────────────────────────────────

const PLATFORM = 'three.ws';
const WEBSITE  = 'https://three.ws';
const X        = 'https://x.com/three_ws';
const GITHUB   = 'https://github.com/nirholas/three.ws';
// $THREE — the only coin on this platform
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const OG_IMAGE   = 'https://three.ws/og.png';

function buildManifest(agent, avatarGlbUrl, avatarThumbUrl) {
	const description = agent.description?.trim() ||
		`${agent.name} — an autonomous agent on ${PLATFORM}.`;
	const image = avatarThumbUrl || OG_IMAGE;

	return {
		name:          agent.name,
		symbol:        'AGENT',
		description,
		image,
		...(avatarGlbUrl ? { animation_url: avatarGlbUrl } : {}),
		external_url:  `${WEBSITE}/agents/${agent.id}`,
		attributes: [
			{ trait_type: 'Platform',  value: PLATFORM },
			{ trait_type: 'Standard',  value: 'Metaplex Core' },
			{ trait_type: 'Schema',    value: 'agent-manifest/0.1' },
			{ trait_type: '$THREE',    value: THREE_MINT },
			{ trait_type: 'Created',   value: new Date(agent.created_at).toISOString() },
		],
		properties: {
			category: avatarGlbUrl ? 'vr' : 'image',
			files: [
				{ uri: image, type: 'image/png' },
				...(avatarGlbUrl ? [{ uri: avatarGlbUrl, type: 'model/gltf-binary' }] : []),
			],
			creators: [{ address: authorityPk, share: 100 }],
		},
		platform: { name: PLATFORM, url: WEBSITE, x: X, github: GITHUB },
		token:    { symbol: '$THREE', mint: THREE_MINT },
		$schema:  'https://3d-agent.io/schemas/manifest/0.1.json',
		spec:     'agent-manifest/0.1',
		tags:     ['three.ws', 'ai-agent'],
		body:     { uri: avatarGlbUrl || '', format: 'gltf-binary' },
		...(agent.avatar_id ? { avatarId: agent.avatar_id } : {}),
	};
}

function buildOnchainAttributes(agent) {
	const clamp = (s, n) => s && s.length > n ? s.slice(0, n - 1) + '…' : (s || '');
	return [
		{ key: 'platform',    value: PLATFORM },
		{ key: 'url',         value: WEBSITE },
		{ key: 'agent',       value: clamp(agent.name, 48) },
		{ key: 'agent_url',   value: `${WEBSITE}/agents/${agent.id}` },
		{ key: 'x',           value: X },
		{ key: 'github',      value: GITHUB },
		{ key: '$THREE',      value: THREE_MINT },
		{ key: 'standard',    value: 'metaplex-core' },
		{ key: 'schema',      value: 'agent-manifest/0.1' },
		{ key: 'created',     value: new Date(agent.created_at).toISOString() },
	];
}

// ── Mint one agent ─────────────────────────────────────────────────────────────

async function mintAgent(agent, ownerAddress, metadataUri) {
	const assetSigner = generateSigner(umi);
	const ownerPk     = umiPublicKey(ownerAddress);
	const royalty = {
		basisPoints: 500,
		creators:    [{ address: ownerPk, percentage: 100 }],
		ruleSet:     ruleSet('None'),
	};

	await create(umi, {
		asset:      assetSigner,
		collection: collectionPk,
		authority:  authoritySigner,
		owner:      ownerPk,
		name:       agent.name.slice(0, 32) || 'Agent',
		uri:        metadataUri,
		plugins: [
			{
				type: 'Attributes',
				attributeList: buildOnchainAttributes(agent),
			},
			{
				type: 'Royalties',
				...royalty,
			},
		],
	}).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });

	return assetSigner.publicKey.toString();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	console.log(`\nthree.ws Agent Batch Mint`);
	console.log(`  network:    ${NETWORK}`);
	console.log(`  rpc:        ${rpc.replace(/api-key=[^&]+/i, 'api-key=***')}`);
	console.log(`  authority:  ${authorityPk}`);
	console.log(`  collection: ${COLLECTION_ADDR}`);
	console.log(`  dry-run:    ${DRY_RUN}`);
	console.log(`  limit:      ${LIMIT || 'all'}`);
	console.log('');

	const db = new Client({ connectionString: DATABASE_URL });
	await db.connect();

	const { rows: agents } = await db.query(`
		SELECT
			ai.id, ai.name, ai.description, ai.user_id, ai.avatar_id, ai.created_at,
			av.storage_key   AS glb_key,
			av.thumbnail_key AS thumb_key,
			apw.address      AS solana_wallet
		FROM agent_identities ai
		JOIN avatars av ON av.id = ai.avatar_id
		LEFT JOIN agent_payout_wallets apw
			ON apw.agent_id = ai.id AND apw.chain = 'solana'
		WHERE ai.avatar_id IS NOT NULL
			AND ai.meta->>'sol_mint_address' IS NULL
			AND ai.deleted_at IS NULL
			AND av.deleted_at IS NULL
		ORDER BY ai.created_at ASC
		${LIMIT ? `LIMIT ${LIMIT}` : ''}
	`);

	console.log(`Found ${agents.length} agents to mint.\n`);
	if (agents.length === 0) { await db.end(); return; }

	let minted = 0, skipped = 0, failed = 0;

	for (const agent of agents) {
		const ownerAddress = agent.solana_wallet || authorityPk;
		const isCustody    = ownerAddress === authorityPk;
		const glbUrl   = agent.glb_key   ? publicUrl(agent.glb_key)   : null;
		const thumbUrl = agent.thumb_key ? publicUrl(agent.thumb_key) : null;

		process.stdout.write(
			`[${minted + failed + 1}/${agents.length}] ${agent.name} (${agent.id.slice(0, 8)}) ` +
			`→ ${isCustody ? 'custody' : agent.solana_wallet.slice(0, 8) + '…'} … `
		);

		if (DRY_RUN) {
			console.log('skip (dry-run)');
			skipped++;
			continue;
		}

		try {
			const metaKey = `agent-manifests/batch/${agent.id}.json`;
			const manifest = buildManifest(agent, glbUrl, thumbUrl);
			const metadataUri = await uploadJson(metaKey, manifest);

			const assetAddress = await mintAgent(agent, ownerAddress, metadataUri);

			await db.query(`
				UPDATE agent_identities
				SET meta = jsonb_set(
					jsonb_set(
						coalesce(meta, '{}'),
						'{sol_mint_address}', to_jsonb($2::text)
					),
					'{onchain}', $3::jsonb
				),
				updated_at = now()
				WHERE id = $1
			`, [
				agent.id,
				assetAddress,
				JSON.stringify({
					chain:            `solana:${NETWORK === 'mainnet' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'}`,
					family:           'solana',
					cluster:          NETWORK,
					onchain_id:       assetAddress,
					contract_or_mint: assetAddress,
					metadata_uri:     metadataUri,
					owner:            ownerAddress,
					custody:          isCustody,
					confirmed_at:     new Date().toISOString(),
				}),
			]);

			console.log(`✓ ${assetAddress}`);
			minted++;
		} catch (err) {
			console.log(`✗ ${err.message}`);
			failed++;
		}

		// ~2 mints/sec — stay well within public RPC limits
		await new Promise(r => setTimeout(r, 500));
	}

	await db.end();

	console.log(`\nDone.`);
	console.log(`  minted:  ${minted}`);
	console.log(`  failed:  ${failed}`);
	console.log(`  skipped: ${skipped}`);
	if (failed > 0) {
		console.log('\nRe-run is safe — already-minted agents are skipped automatically.');
	}
}

main().catch((err) => {
	console.error('\n❌ Fatal:', err?.message || err);
	process.exit(1);
});

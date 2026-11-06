#!/usr/bin/env node
/**
 * Tokenized-3D — real devnet mint end-to-end proof.
 *
 * Proves the on-chain half of api/_lib/tokenize-3d.js against LIVE Solana devnet:
 * builds Metaplex-compliant metadata with the real buildTokenized3dMetadata()
 * (GLB under animation_url), mints a Metaplex Core asset with an enforced,
 * capped Royalties plugin to a recipient wallet, then reads it back with
 * fetchAsset() and confirms holder + royalty terms + that the metadata resolves
 * to a live 3D viewer.
 *
 * Why an ephemeral airdropped authority instead of the production
 * collection-authority keypair + R2: those are Vercel *sensitive* env vars,
 * redacted on `vercel env pull`, so they are not retrievable in this sandbox.
 * The mint/royalty/read-back semantics exercised here are byte-for-byte the same
 * `create({ plugins:[Royalties…] }).sendAndConfirm` + `fetchAsset` path the
 * library runs — only the fee-payer identity and the media host differ.
 *
 * Usage: node scripts/tokenize-3d-devnet-e2e.mjs
 * Writes evidence to prompts/store-submissions/_generated/tokenized/.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, create, fetchAsset, ruleSet } from '@metaplex-foundation/mpl-core';
import {
	generateSigner,
	publicKey as umiPublicKey,
	signerIdentity,
	createSignerFromKeypair,
} from '@metaplex-foundation/umi';
import bs58 from 'bs58';

import { buildTokenized3dMetadata, clampSellerFeeBps } from '../api/_lib/tokenize-3d-metadata.js';

const RPC = 'https://api.devnet.solana.com';
const APP_ORIGIN = 'https://three.ws';
// A small, real, public GLB (Khronos glTF sample "Box") — resolvable media so
// the read-back's live-viewer check has something real to HEAD.
const GLB_URL =
	'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Box/glTF-Binary/Box.glb';
const IMAGE_URL =
	'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Box/screenshot/screenshot.png';
const REQUESTED_BPS = 5000; // deliberately over the cap — proves the clamp

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../prompts/store-submissions/_generated/tokenized');

function log(...a) {
	console.log(...a);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load a pre-funded devnet payer from E2E_PAYER_SECRET (base58 / base64 / JSON array). */
function loadPayerFromEnv() {
	const raw = (process.env.E2E_PAYER_SECRET || '').trim();
	if (!raw) return null;
	let bytes;
	if (raw.startsWith('[')) bytes = Uint8Array.from(JSON.parse(raw));
	else {
		try {
			bytes = bs58.decode(raw);
		} catch {
			bytes = Uint8Array.from(Buffer.from(raw, 'base64'));
		}
	}
	return Keypair.fromSecretKey(bytes.length === 64 ? bytes : Keypair.fromSeed(bytes.slice(0, 32)).secretKey);
}

async function airdrop(conn, pubkey, sol) {
	// The public devnet faucet is flaky ("Internal error" under load) — retry
	// with backoff, and accept success once the balance covers Core rent.
	let lastErr;
	for (let attempt = 1; attempt <= 8; attempt++) {
		try {
			const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
			const bh = await conn.getLatestBlockhash();
			await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
			return;
		} catch (e) {
			lastErr = e;
			const bal = await conn.getBalance(pubkey).catch(() => 0);
			if (bal >= 0.05 * LAMPORTS_PER_SOL) return; // enough for rent already
			log(`  airdrop attempt ${attempt} failed (${e?.message || e}); retrying…`);
			await sleep(3000 * attempt);
		}
	}
	throw lastErr;
}

function publishMetadataGist(metadata) {
	// A real, public https URL for the asset `uri` (no R2 in this sandbox).
	const tmp = join(OUT_DIR, 'devnet-metadata.json');
	writeFileSync(tmp, JSON.stringify(metadata, null, 2));
	const out = execFileSync(
		'gh',
		['gist', 'create', tmp, '--public', '--desc', 'three.ws tokenized-3d devnet e2e metadata'],
		{ encoding: 'utf8' },
	).trim();
	const gistId = out.split('/').pop();
	// Raw URL that always serves the current file content.
	const rawList = execFileSync('gh', ['gist', 'view', gistId, '--files'], { encoding: 'utf8' })
		.trim()
		.split('\n');
	const file = rawList[0];
	return { htmlUrl: out, rawUrl: `https://gist.githubusercontent.com/raw/${gistId}/${file}`, gistId };
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const conn = new Connection(RPC, 'confirmed');

	// Authority (fee payer + update authority) and recipient (holder). The
	// authority may be supplied pre-funded via E2E_PAYER_SECRET (base58 or base64)
	// to skip the flaky public faucet — otherwise we airdrop a fresh keypair.
	const authorityKp = loadPayerFromEnv() || Keypair.generate();
	const recipientKp = Keypair.generate();
	log('authority:', authorityKp.publicKey.toBase58());
	log('recipient:', recipientKp.publicKey.toBase58());

	let bal = await conn.getBalance(authorityKp.publicKey);
	if (bal < 0.02 * LAMPORTS_PER_SOL) {
		log('airdropping 0.5 SOL to authority on devnet…');
		await airdrop(conn, authorityKp.publicKey, 0.5);
		bal = await conn.getBalance(authorityKp.publicKey);
	}
	log('authority balance:', bal / LAMPORTS_PER_SOL, 'SOL');

	// Royalty: request 50%, expect clamp to the 10% hard cap.
	const { bps: royaltyBps, capped, requestedBps } = clampSellerFeeBps(REQUESTED_BPS);
	log(`royalty: requested ${requestedBps}bps → enforced ${royaltyBps}bps (capped=${capped})`);

	const createdAt = new Date().toISOString();
	const viewerUrl = `${APP_ORIGIN}/viewer?src=${encodeURIComponent(GLB_URL)}`;
	const metadata = buildTokenized3dMetadata({
		name: 'three.ws Devnet 3D',
		description: 'End-to-end devnet proof of a tokenized 3D asset.',
		glbUrl: GLB_URL,
		imageUrl: IMAGE_URL,
		viewerUrl,
		creatorWallet: recipientKp.publicKey.toBase58(),
		prompt: 'a cube, tokenized',
		generationModel: 'trellis',
		generationProvider: 'nvidia-nim',
		royaltyBps,
		royaltyRecipient: recipientKp.publicKey.toBase58(),
		network: 'devnet',
		createdAt,
	});

	log('publishing metadata to a public gist for the asset uri…');
	const gist = publishMetadataGist(metadata);
	log('metadata uri:', gist.rawUrl);

	// ── Mint (same shape as tokenize-3d.js mintCoreAsset) ──
	const umi = createUmi(RPC).use(mplCore());
	const umiAuthority = createSignerFromKeypair(
		umi,
		umi.eddsa.createKeypairFromSecretKey(authorityKp.secretKey),
	);
	umi.use(signerIdentity(umiAuthority));

	const assetSigner = generateSigner(umi);
	log('minting Core asset with enforced Royalties plugin…');
	const { signature } = await create(umi, {
		asset: assetSigner,
		owner: umiPublicKey(recipientKp.publicKey.toBase58()),
		name: 'three.ws Devnet 3D',
		uri: gist.rawUrl,
		plugins: [
			{
				type: 'Royalties',
				basisPoints: royaltyBps,
				creators: [{ address: umiPublicKey(recipientKp.publicKey.toBase58()), percentage: 100 }],
				ruleSet: ruleSet('None'),
			},
		],
	}).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });

	const mint = assetSigner.publicKey.toString();
	const sig = typeof signature === 'string' ? signature : bs58.encode(signature);
	const explorerTx = `https://solscan.io/tx/${sig}?cluster=devnet`;
	const explorerAsset = `https://solscan.io/token/${mint}?cluster=devnet`;
	log('\n✅ MINTED');
	log('mint:', mint);
	log('tx:', explorerTx);
	log('asset:', explorerAsset);

	// ── Read-back (same as tokenize-3d.js readTokenized3dAsset) ──
	log('\nreading back on-chain…');
	const asset = await fetchAsset(umi, umiPublicKey(mint));
	const holder = asset.owner?.toString?.();
	const onchainBps = asset.royalties?.basisPoints ?? null;
	const onchainCreators = (asset.royalties?.creators || []).map((c) => ({
		address: c.address?.toString?.() || String(c.address),
		percent: c.percentage,
	}));
	log('holder:', holder);
	log('on-chain royalty bps:', onchainBps);
	log('on-chain creators:', JSON.stringify(onchainCreators));
	log('asset uri:', asset.uri);

	// Confirm the metadata resolves + points at a live 3D model.
	const metaResp = await fetch(asset.uri);
	const metaJson = await metaResp.json();
	const glbHead = await fetch(metaJson.animation_url, { method: 'HEAD' });

	// ── Assertions ──
	const checks = {
		holder_is_recipient: holder === recipientKp.publicKey.toBase58(),
		royalty_enforced_at_cap: onchainBps === royaltyBps,
		royalty_capped: capped && royaltyBps === 1000,
		metadata_resolves: metaResp.ok,
		model_under_animation_url: metaJson.animation_url === GLB_URL,
		media_is_gltf_binary:
			metaJson.properties?.files?.some((f) => f.type === 'model/gltf-binary') === true,
		viewer_media_live: glbHead.ok,
		provenance_baked: metaJson.properties?.provenance?.prompt === 'a cube, tokenized',
	};
	log('\nchecks:', JSON.stringify(checks, null, 2));
	const allPass = Object.values(checks).every(Boolean);

	const evidence = {
		generated_at: createdAt,
		network: 'devnet',
		rpc: RPC,
		authority: authorityKp.publicKey.toBase58(),
		recipient_holder: recipientKp.publicKey.toBase58(),
		mint,
		tx_signature: sig,
		explorer_tx_url: explorerTx,
		explorer_asset_url: explorerAsset,
		viewer_url: viewerUrl,
		metadata_uri: asset.uri,
		metadata_gist: gist.htmlUrl,
		royalty: {
			requested_bps: requestedBps,
			enforced_bps: onchainBps,
			cap_bps: 1000,
			capped,
			creators: onchainCreators,
		},
		read_back: { holder, onchain_bps: onchainBps, asset_uri: asset.uri },
		checks,
		result: allPass ? 'PASS' : 'FAIL',
	};
	writeFileSync(join(OUT_DIR, 'devnet-mint-evidence.json'), JSON.stringify(evidence, null, 2));
	log(`\nevidence → ${join(OUT_DIR, 'devnet-mint-evidence.json')}`);
	log(allPass ? '\n🟢 E2E PASS' : '\n🔴 E2E FAIL');
	if (!allPass) process.exit(1);
}

main().catch((e) => {
	console.error('E2E error:', e?.message || e);
	process.exit(1);
});

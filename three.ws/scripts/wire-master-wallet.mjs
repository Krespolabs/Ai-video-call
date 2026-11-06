#!/usr/bin/env node
// Wire the platform's Solana signer slots across the economy wallets.
//
// three.ws has no single "master wallet" env var — each autonomous engine loads
// its own keypair from its own env var (see api/_lib/solana-signers.js). This
// operator tool assigns each signer slot to one of the economy wallets and sets
// every var, in the encoding its consumer expects, from the right wallet's key.
//
// Wallets (label → pubkey) and the slot→wallet assignment live in WALLETS /
// ASSIGNMENTS below — edit those to remap. Provide a secret per wallet you want
// to wire; slots whose wallet key you didn't provide are skipped (do them later).
//
// SECURITY
//   - Secrets are read from files (or stdin for a single wallet), NEVER a CLI arg.
//   - Each is decoded locally, its pubkey derived, and MUST match the wallet's
//     expected pubkey or the run aborts (guards against wiring the wrong key).
//   - Secrets are never printed. Env vars are set --sensitive.
//   - Default is a dry run: prints the plan, sets nothing. Pass --apply.
//   - Slots that are already LIVE on a funded wallet (e.g. labor escrow) are
//     skipped unless you pass --include-live, so you don't strand escrowed funds.
//
// USAGE
//   # dry run — show the full plan for whichever keys you supply:
//   node scripts/wire-master-wallet.mjs --key wwwqv=./wwwqv.key --key wwwu=./wwwu.key
//
//   # apply to production, overwriting existing vars:
//   node scripts/wire-master-wallet.mjs \
//     --key wwwww=./wwwww.key --key wwwqv=./wwwqv.key --key wwwu=./wwwu.key \
//     --apply --overwrite
//
//   # also target preview; also touch already-live slots (careful):
//   ... --preview --include-live
//
// Each key file may hold the secret as base58, base64, or a JSON array of 64
// ints — all auto-detected. After applying, verify with:
//   node scripts/check-relayer-balances.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { decodeSecretKey } = await import(path.join(ROOT, 'api/_lib/solana-signers.js'));

// The economy wallets. Each signer slot is assigned to one of these.
const WALLETS = {
	wwwww: {
		pubkey: 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU',
		desc: 'x402 receiver + closed-loop spender (holds USDC)',
	},
	wwwqv: {
		pubkey: 'wwwqvAbN4RjaRvfGsorxMuauq7SWVcV13Aa7GaqHGUn',
		desc: 'SOL-burning autonomous engines (funded ~2.77 SOL)',
	},
	Wwwu: {
		pubkey: 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW',
		desc: 'platform treasury + revenue/payouts face (funded ~10 SOL + USDC)',
	},
};

// slot → wallet, with the encoding its consumer expects.
// live:true  → already funded/live on its current wallet; skip unless --include-live.
const ASSIGNMENTS = [
	// ── wwwww: x402 closed loop (money recirculates to this same wallet) ──
	{ env: 'X402_SEED_SOLANA_SECRET_BASE58', wallet: 'wwwww', enc: 'base58', note: 'x402 autonomous/seed spender' },
	{ env: 'PUMP_X402_LAUNCHER_SECRET_KEY_B64', wallet: 'wwwww', enc: 'base64', note: 'x402 pay-per-call launches' },
	{ env: 'A2A_PAYER_SOLANA_SECRET', wallet: 'wwwww', enc: 'base58', note: 'a2a mandate settlements' },

	// ── wwwqv: the SOL-spending autonomous engines (it already holds SOL) ──
	{ env: 'LAUNCHER_MASTER_SECRET_KEY_B64', wallet: 'wwwqv', enc: 'base64', note: 'autonomous coin launcher master (highest SOL floor)' },
	{ env: 'PUMP_CRON_RELAYER_SECRET_KEY_B64', wallet: 'wwwqv', enc: 'base64', note: 'buyback + distribute cron gas' },
	{ env: 'CIRCULATION_TREASURY_SECRET', wallet: 'wwwqv', enc: 'base58', note: 'circulation engine treasury' },
	{ env: 'THREEWS_SOL_PARENT_SECRET_BASE58', wallet: 'wwwqv', enc: 'base58', note: 'threews.sol subdomain minting' },
	{ env: 'COIN_TREASURY_SECRET_KEY_B64', wallet: 'wwwqv', enc: 'base64', note: 'coin lottery/reflection payouts (strict base64)' },

	// ── wwwu: the platform treasury + revenue/payout face (fund it) ──
	{ env: 'PLATFORM_TREASURY_KEYPAIR', wallet: 'Wwwu', enc: 'base64', note: 'shared platform treasury / withdrawal gas' },
	{ env: 'MARKETPLACE_PAYER_KEYPAIR', wallet: 'Wwwu', enc: 'base64', note: 'gasless checkout fee-payer' },
	{ env: 'THREE_BUYBACK_SECRET_KEY_B64', wallet: 'Wwwu', enc: 'base64', note: '$THREE buyback (holds USDC revenue)' },
	{ env: 'CLUB_SOLANA_TREASURY_SECRET_KEY_B64', wallet: 'Wwwu', enc: 'base64', note: 'club tip sweeps' },
	{ env: 'VANITY_BOUNTY_PAYOUT_KEY', wallet: 'Wwwu', enc: 'base58', note: 'vanity bounty payouts (strict base58)' },
	{ env: 'REWARDS_DISTRIBUTOR_SECRET', wallet: 'Wwwu', enc: 'base58', note: '$THREE holder rewards distributor' },

	// ── already LIVE — skipped unless --include-live (rerouting strands funds) ──
	{ env: 'LABOR_ESCROW_SECRET_BASE58', wallet: 'Wwwu', enc: 'base58', live: true, note: 'labor escrow — LIVE on its own wallet; migrate balances before rerouting' },

	// Intentionally EXCLUDED entirely: SOLANA_AGENT_COLLECTION_AUTHORITY_KEY
	// (on-chain NFT-collection update authority — must stay its original wallet).
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has('--apply');
const OVERWRITE = has('--overwrite');
const PREVIEW = has('--preview');
const INCLUDE_LIVE = has('--include-live');

function fail(msg) {
	console.error(`\n✗ ${msg}\n`);
	process.exit(1);
}

// Collect --key label=path (repeatable). Single wallet may use stdin.
const keyPaths = {};
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--key') {
		const [label, ...rest] = (argv[i + 1] || '').split('=');
		if (!label || !rest.length) fail(`--key expects <label>=<path>, got "${argv[i + 1]}"`);
		if (!WALLETS[label]) fail(`unknown wallet label "${label}". Known: ${Object.keys(WALLETS).join(', ')}`);
		keyPaths[label] = rest.join('=');
	}
}

async function loadWalletKey(label, source) {
	let secret;
	if (source === '-' || (source === undefined && !process.stdin.isTTY)) {
		secret = fs.readFileSync(0, 'utf8').trim();
	} else {
		if (!fs.existsSync(source)) fail(`key file for ${label} not found: ${source}`);
		secret = fs.readFileSync(source, 'utf8').trim();
	}
	const bytes = await decodeSecretKey(secret);
	if (!bytes || bytes.length !== 64) fail(`${label}: could not decode a 64-byte secret key`);
	const { Keypair } = await import('@solana/web3.js');
	const bs58mod = await import('bs58');
	const bs58 = bs58mod.default || bs58mod;
	const kp = Keypair.fromSecretKey(bytes);
	const pubkey = kp.publicKey.toBase58();
	if (pubkey !== WALLETS[label].pubkey) {
		fail(`${label}: key derives to ${pubkey} but expected ${WALLETS[label].pubkey}`);
	}
	return { base64: Buffer.from(bytes).toString('base64'), base58: bs58.encode(bytes) };
}

async function main() {
	const scopes = ['production', ...(PREVIEW ? ['preview'] : [])];

	// Load whichever wallet keys were provided.
	const encoded = {};
	for (const [label, src] of Object.entries(keyPaths)) {
		encoded[label] = await loadWalletKey(label, src);
	}
	const provided = Object.keys(encoded);
	if (!provided.length && APPLY) fail('No keys provided. Pass --key <label>=<path> for the wallets you want to wire.');

	console.log(`\nMode: ${APPLY ? 'APPLY' : 'DRY RUN (nothing will change)'}${OVERWRITE ? '  overwrite=on' : ''}`);
	console.log(`Scopes: ${scopes.join(', ')}`);
	console.log(`Keys provided: ${provided.length ? provided.join(', ') : '(none — dry-run plan only)'}\n`);

	let set = 0;
	let skipped = 0;
	let failed = 0;
	for (const a of ASSIGNMENTS) {
		const w = WALLETS[a.wallet];
		const tag = `${a.env} ← ${a.wallet} (${a.enc})`;
		if (a.live && !INCLUDE_LIVE) {
			console.log(`  ⏭ skip live ${tag} — ${a.note} (use --include-live to force)`);
			skipped++;
			continue;
		}
		if (!encoded[a.wallet]) {
			console.log(`  ⏭ no key    ${tag} — ${a.note}`);
			skipped++;
			continue;
		}
		const value = encoded[a.wallet][a.enc];
		for (const scope of scopes) {
			const label = `${tag} [${scope}]`;
			if (!APPLY) {
				console.log(`  would set  ${label} — ${a.note}`);
				continue;
			}
			if (OVERWRITE) spawnSync('vercel', ['env', 'rm', a.env, scope, '-y'], { stdio: 'ignore' });
			const res = spawnSync('vercel', ['env', 'add', a.env, scope, '--sensitive'], { input: value, encoding: 'utf8' });
			if (res.status === 0) {
				console.log(`  ✓ set      ${label}`);
				set++;
			} else {
				console.log(`  ✗ FAILED   ${label} — ${(res.stderr || '').trim().split('\n').pop()}`);
				failed++;
			}
		}
	}

	console.log(`\nWallets:`);
	for (const [label, w] of Object.entries(WALLETS)) console.log(`  ${label}  ${w.pubkey}  — ${w.desc}`);
	if (!APPLY) {
		console.log(`\nDry run only. Provide --key for each wallet, then re-run with --apply --overwrite.`);
	} else {
		console.log(`\nDone: ${set} set, ${skipped} skipped, ${failed} failed.`);
		console.log(`Redeploy, then verify: node scripts/check-relayer-balances.mjs`);
		if (failed) process.exitCode = 1;
	}
}

main().catch((e) => fail(e?.message || String(e)));

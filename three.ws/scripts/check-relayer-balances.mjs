#!/usr/bin/env node
// Solana relayer balance report — operator companion to the
// /api/cron/relayer-balance-check watchdog. Same registry (api/_lib/solana-signers.js),
// run on demand from a machine that has the signer secrets.
//
// For every signer it can decode, prints the pubkey, SOL balance, USDC balance,
// and whether it's above its documented minimum. Unconfigured signers are listed
// as "(unset)" so you can see at a glance what the current deployment actually
// holds. Exit code is non-zero if any configured signer is underfunded — wire it
// into a pre-deploy check if you like.
//
// Usage:
//   node scripts/check-relayer-balances.mjs                 # reads .env.local then env
//   SOLANA_RPC_URL=https://… node scripts/check-relayer-balances.mjs
//   node scripts/check-relayer-balances.mjs --network devnet
//
// Never prints or logs any secret — pubkeys and balances only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import w3 from '@solana/web3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env.local without overriding anything already in the environment.
const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) {
	for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
	}
}

const { SOLANA_SIGNERS, resolveSignerPubkey } = await import(
	path.join(ROOT, 'api/_lib/solana-signers.js')
);

const networkArg = process.argv.includes('--network')
	? process.argv[process.argv.indexOf('--network') + 1]
	: 'mainnet';
const rpcUrl =
	networkArg === 'devnet'
		? process.env.SOLANA_RPC_URL_DEVNET || w3.clusterApiUrl('devnet')
		: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const USDC =
	networkArg === 'devnet'
		? new w3.PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU') // USDC-Dev
		: new w3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC

const conn = new w3.Connection(rpcUrl, 'confirmed');
console.log(`network: ${networkArg}  rpc: ${rpcUrl}\n`);
console.log('signer'.padEnd(24), 'pubkey'.padEnd(46), 'SOL'.padStart(12), 'min', 'USDC');
console.log('-'.repeat(100));

let underfunded = 0;
for (const spec of SOLANA_SIGNERS) {
	const resolved = await resolveSignerPubkey(spec);
	if (!resolved.configured) {
		console.log(spec.name.padEnd(24), '(unset)'.padEnd(46), '—'.padStart(12), spec.minSol);
		continue;
	}
	if (resolved.decodeError || !resolved.pubkey) {
		console.log(spec.name.padEnd(24), 'DECODE FAILED'.padEnd(46), '—'.padStart(12), spec.minSol);
		underfunded++;
		continue;
	}
	const pk = new w3.PublicKey(resolved.pubkey);
	const lamports = await conn.getBalance(pk).catch(() => null);
	const sol = lamports == null ? null : lamports / 1e9;
	let usdc = null;
	try {
		const r = await conn.getParsedTokenAccountsByOwner(pk, { mint: USDC });
		usdc = r.value[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
	} catch {
		/* no token account */
	}
	const low = sol != null && sol < spec.minSol;
	if (low) underfunded++;
	const solStr = sol == null ? 'rpc-err' : sol.toFixed(6);
	const flag = low ? ' ⚠️ LOW' : '';
	console.log(
		spec.name.padEnd(24),
		resolved.pubkey.padEnd(46),
		solStr.padStart(12),
		String(spec.minSol).padStart(4),
		usdc ?? '-',
		flag,
	);
}

console.log('-'.repeat(100));
if (underfunded > 0) {
	console.log(`\n${underfunded} signer(s) underfunded or unreadable on ${networkArg}.`);
	process.exit(1);
}
console.log(`\nAll configured signers funded on ${networkArg}.`);

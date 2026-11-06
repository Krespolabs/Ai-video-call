#!/usr/bin/env node
// Generate the avatar's custodial Solana wallet for the avatar-wallet-chat
// widget. Writes the secret to .env (AVATAR_WALLET_SECRET) so it never prints
// to your terminal, and shows the public address you need to fund.
//
//   node scripts/gen-avatar-wallet.mjs
//
// Then fund the printed address with a few dollars of SOL and (for the real
// mainnet demo) make sure your deployment has the same AVATAR_WALLET_SECRET.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const bs58encode = bs58.default ? bs58.default.encode : bs58.encode;
const ENV_PATH = resolve(process.cwd(), '.env');

function readEnv() {
	if (!existsSync(ENV_PATH)) return '';
	return readFileSync(ENV_PATH, 'utf8');
}

function hasVar(contents, name) {
	return new RegExp(`^${name}=`, 'm').test(contents);
}

function upsert(contents, name, value) {
	if (hasVar(contents, name)) return contents; // never clobber existing values
	const sep = contents && !contents.endsWith('\n') ? '\n' : '';
	return `${contents}${sep}${name}=${value}\n`;
}

const existing = readEnv();
if (hasVar(existing, 'AVATAR_WALLET_SECRET')) {
	console.error('✗ AVATAR_WALLET_SECRET already exists in .env — refusing to overwrite.');
	console.error('  Remove it first if you really want a new wallet.');
	process.exit(1);
}

const kp = Keypair.generate();
const address = kp.publicKey.toBase58();
const secret = bs58encode(kp.secretKey);

let next = upsert(existing, 'AVATAR_WALLET_SECRET', secret);
next = upsert(next, 'AVATAR_NETWORK', 'mainnet');
next = upsert(next, 'AVATAR_MAX_SEND_USD', '2');
writeFileSync(ENV_PATH, next, { mode: 0o600 });

console.log('');
console.log('  ✓ Avatar wallet created. Secret written to .env (AVATAR_WALLET_SECRET).');
console.log('');
console.log('  Public address (fund this):');
console.log(`    ${address}`);
console.log('');
console.log('  Explorer:');
console.log(`    https://solscan.io/account/${address}`);
console.log('');
console.log('  Next steps:');
console.log('    1. Send ~$3 of SOL to the address above (mainnet).');
console.log('    2. Set the SAME env vars on your deployment:');
console.log('         AVATAR_WALLET_SECRET, AVATAR_NETWORK=mainnet, AVATAR_MAX_SEND_USD=2');
console.log('         Optional: AVATAR_DEFAULT_RECIPIENT=<your address>  (the "send me" target)');
console.log('         Optional: AVATAR_LOCK_RECIPIENT=1  (drain-proof: always pays your default, ignores client addresses)');
console.log('         Optional: AVATAR_DEMO_TOKEN=<secret>  (then load the widget with ?token=<secret>)');
console.log('    3. Open /avatar-wallet-chat and say: "send me $1 of SOL".');
console.log('');
console.log('  Tip: try it on devnet first — set AVATAR_NETWORK=devnet and run');
console.log('       node scripts/verify-send-sol.mjs  (free, proves the on-chain path).');
console.log('');

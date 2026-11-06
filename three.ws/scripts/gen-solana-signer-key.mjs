#!/usr/bin/env node
// Generate a Solana ed25519 signer keypair in the base64 `_SECRET_KEY_B64`
// format the server-side signers expect (api/_lib/solana-signers.js →
// decodeSecretKey: base64 of the 64 raw secret-key bytes). Use it for any of
// the platform's *_SECRET_KEY_B64 vars — PUMP_CRON_RELAYER, COIN_TREASURY,
// THREE_BUYBACK, CLUB_SOLANA_TREASURY, PUMP_X402_LAUNCHER.
//
// Dependency-free (node:crypto only), so it runs without installing
// @solana/web3.js. The output is byte-for-byte compatible with
// Keypair.fromSecretKey.
//
//   node scripts/gen-solana-signer-key.mjs                       # print pubkey + b64
//   node scripts/gen-solana-signer-key.mjs --vanity www          # grind a vanity prefix (case-insensitive)
//   node scripts/gen-solana-signer-key.mjs --var PUMP_CRON_RELAYER_SECRET_KEY_B64 --write
//
// --write upserts into .env WITHOUT clobbering an existing value (so you never
// overwrite a funded signer by accident) and keeps the secret off your scrollback.
// Fund the printed public key with SOL before the cron can pay tx fees.

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(buf) {
	const digits = [0];
	for (const byte of buf) {
		let carry = byte;
		for (let j = 0; j < digits.length; j++) {
			carry += digits[j] << 8;
			digits[j] = carry % 58;
			carry = (carry / 58) | 0;
		}
		while (carry) {
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}
	let str = '';
	for (const b of buf) {
		if (b === 0) str += '1';
		else break;
	}
	for (let i = digits.length - 1; i >= 0; i--) str += BASE58[digits[i]];
	return str;
}

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const vanity = (arg('--vanity') || '').trim();
if (vanity && [...vanity].some((c) => !BASE58.includes(c))) {
	console.error(`Invalid vanity prefix "${vanity}" — base58 has no 0, O, I, or l.`);
	process.exit(1);
}
const varName = arg('--var') || 'PUMP_CRON_RELAYER_SECRET_KEY_B64';
const write = process.argv.includes('--write');

function generate() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
	// pkcs8 DER ends with the 32-byte seed; spki DER ends with the 32-byte pubkey.
	const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
	const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
	return { secretKey: Buffer.concat([seed, pub]), pubkey: base58(pub) };
}

const start = Date.now();
let tries = 0;
let kp;
const want = vanity.toLowerCase();
do {
	tries++;
	kp = generate();
} while (want && kp.pubkey.slice(0, want.length).toLowerCase() !== want);

const b64 = kp.secretKey.toString('base64');
if (Buffer.from(b64, 'base64').length !== 64) {
	console.error('Sanity check failed: secret key is not 64 bytes.');
	process.exit(1);
}

if (vanity) {
	console.error(
		`Matched "${vanity}" prefix in ${tries.toLocaleString()} tries (${((Date.now() - start) / 1000).toFixed(1)}s)`,
	);
}

if (write) {
	const ENV_PATH = resolve(process.cwd(), '.env');
	const contents = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
	if (new RegExp(`^${varName}=.+`, 'm').test(contents)) {
		console.error(`${varName} already set in .env — refusing to clobber. Remove it first to rotate.`);
		process.exit(1);
	}
	const sep = contents && !contents.endsWith('\n') ? '\n' : '';
	const next = new RegExp(`^${varName}=$`, 'm').test(contents)
		? contents.replace(new RegExp(`^${varName}=$`, 'm'), `${varName}=${b64}`)
		: `${contents}${sep}${varName}=${b64}\n`;
	writeFileSync(ENV_PATH, next);
	console.error(`Wrote ${varName} to .env (secret kept off your terminal).`);
	console.log(`Fund this public key with SOL: ${kp.pubkey}`);
} else {
	console.log(`Public key (fund this address with SOL): ${kp.pubkey}`);
	console.log('');
	console.log(`${varName}=${b64}`);
}

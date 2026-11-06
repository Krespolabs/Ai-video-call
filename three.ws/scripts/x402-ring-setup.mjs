#!/usr/bin/env node
// scripts/x402-ring-setup.mjs
//
// Bootstrap the closed-loop agent-to-agent x402 ring: generate the platform-
// controlled role wallets, write their secrets to a GITIGNORED local file, and
// print a ready-to-paste env block. It NEVER funds anything and NEVER touches
// mainnet — funding the wallets with real USDC/SOL is a deliberate manual step.
//
// Roles (all wallets are three.ws-controlled — nothing here is a user wallet):
//   sponsor  → pays Solana fees for every settle. Env: X402_FEE_PAYER_SOLANA (pub)
//              + X402_FEE_PAYER_SECRET_BASE58 (secret). Fund with a little SOL.
//   treasury → receives every ring payment. Env: X402_PAY_TO_SOLANA (pub)
//              + X402_TREASURY_SECRET_BASE58 (secret, used by the rebalancer).
//   payer    → the ring wallet that pays. Env: X402_SEED_SOLANA_SECRET_BASE58
//              (secret). Fund with the USDC float that will recirculate.
//
// Usage:
//   node scripts/x402-ring-setup.mjs                 # generate all three roles
//   node scripts/x402-ring-setup.mjs --roles=payer   # just one role
//   node scripts/x402-ring-setup.mjs --out=./secrets.json
//   node scripts/x402-ring-setup.mjs --register      # also record pubkeys in DB
//   node scripts/x402-ring-setup.mjs --print-secrets # echo secrets to stdout too
//   node scripts/x402-ring-setup.mjs --force-regenerate  # bypass the overwrite guard (DANGER)
//
// A role that already has a key (in the secrets file or env) is NEVER
// regenerated without --force-regenerate — an existing wallet may hold funds.

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
	const p = args.find((a) => a.startsWith(`--${name}=`));
	return p ? p.slice(name.length + 3) : def;
};

const ROLE_ENV = {
	sponsor: { pub: 'X402_FEE_PAYER_SOLANA', secret: 'X402_FEE_PAYER_SECRET_BASE58' },
	treasury: { pub: 'X402_PAY_TO_SOLANA', secret: 'X402_TREASURY_SECRET_BASE58' },
	payer: { pub: null, secret: 'X402_SEED_SOLANA_SECRET_BASE58' },
};

const roles = String(opt('roles', 'sponsor,treasury,payer'))
	.split(',')
	.map((r) => r.trim())
	.filter((r) => ROLE_ENV[r]);

if (roles.length === 0) {
	console.error('No valid roles. Choose from: sponsor, treasury, payer');
	process.exit(1);
}

const outFile = opt('out', '.x402-ring-secrets.json');
const printSecrets = flag('print-secrets');

// Overwrite guard: a role that already has a key — in the secrets file or in
// env — may hold funds. Regenerating it would orphan that wallet. Refuse unless
// the operator explicitly passes --force-regenerate for that run.
const existing = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};
const forceRegenerate = flag('force-regenerate');
const blocked = roles.filter(
	(role) => !forceRegenerate && (existing[role]?.secret || process.env[ROLE_ENV[role].secret]),
);
if (blocked.length > 0) {
	console.error(
		`Refusing to regenerate role(s) that already have a key: ${blocked.join(', ')}.\n` +
			`An existing role wallet may hold funds — regenerating orphans it.\n` +
			`Use --roles=<missing roles only>, or --force-regenerate if you are CERTAIN the old wallets are empty and retired.`,
	);
	process.exit(1);
}

const generated = { ...existing };
const envLines = [];
for (const role of roles) {
	const kp = Keypair.generate();
	const pub = kp.publicKey.toBase58();
	const secret = bs58.encode(kp.secretKey);
	generated[role] = { pubkey: pub, secret };
	const map = ROLE_ENV[role];
	if (map.pub) envLines.push(`${map.pub}=${pub}`);
	envLines.push(`${map.secret}=${secret}`);
}

// Persist secrets to a gitignored file so they are not lost and never echoed
// into shell history / CI logs by default. Roles not generated this run are
// carried over from the existing file untouched.
writeFileSync(outFile, JSON.stringify(generated, null, 2) + '\n', { mode: 0o600 });

console.log('\n=== three.ws x402 ring — wallets generated ===\n');
for (const role of roles) {
	console.log(`  ${role.padEnd(9)} pubkey: ${generated[role].pubkey}`);
}
console.log(`\nSecrets written to ${outFile} (chmod 600, gitignored). KEEP THIS FILE SAFE.\n`);

console.log('=== Env block — paste into Vercel (or .env) ===\n');
console.log(envLines.map((l) => (printSecrets ? l : redact(l))).join('\n'));

console.log('\n=== Turn the ring ON (review before setting) ===\n');
console.log(
	[
		'X402_SELF_FACILITATOR_ENABLED=true',
		'X402_FACILITATOR_URL_SOLANA=https://three.ws/api/x402-facilitator',
		'X402_EXTERNAL_ENABLED=false            # only OUR endpoints get paid',
		'X402_CHARITY_AUDIT_BPS=0               # no charity split leaves the ring',
		'X402_RING_SELF_PAY=true                # payer pays its own fee → 1 signature (5000 lamports), half the SOL',
		'X402_PRICE_RING_SETTLE=1000000         # $1.00/call → few txs; raise to $10–$100 for near-zero SOL',
		'X402_AUTONOMOUS_DAILY_CAP_ATOMIC=…     # set to your daily volume target',
		'X402_VOLUME_PER_RUN_CAP_ATOMIC=…       # per-tick ceiling',
		'X402_SPONSOR_SOL_FLOOR_LAMPORTS=20000000  # pause the loop below 0.02 SOL',
	].join('\n'),
);

console.log('\n=== Funding (manual — real money, do this yourself) ===\n');
console.log('  payer    → USDC float that recirculates (e.g. $50) + a little SOL for its OWN fees in self-pay mode');
console.log('             (e.g. 0.1 SOL ≈ thousands of 1-signature settlements). Watch /api/x402-ring.');
console.log('  treasury → 0 to start; it fills from ring payments, the rebalancer sweeps it back to payer.');
console.log('  sponsor  → ONLY if you turn OFF self-pay (unset X402_RING_SELF_PAY): fund it with the fee SOL instead.');
console.log('');

if (flag('register')) {
	try {
		const { sql } = await import('../api/_lib/db.js');
		for (const role of roles) {
			await sql`
				INSERT INTO x402_ring_wallets (pubkey, label, role, enabled)
				VALUES (${generated[role].pubkey}, ${`ring-${role}`}, ${role}, true)
				ON CONFLICT (pubkey) DO UPDATE SET role = EXCLUDED.role, enabled = true
			`;
		}
		console.log(`Registered ${roles.length} wallet(s) in x402_ring_wallets.\n`);
	} catch (err) {
		console.error(`--register failed (need DATABASE_URL + migration applied): ${err.message}\n`);
	}
}

function redact(line) {
	const [k, v] = line.split('=');
	if (/SECRET/.test(k) && v && v.length > 12) {
		return `${k}=${v.slice(0, 4)}…${v.slice(-4)}  (full value in ${outFile})`;
	}
	return line;
}

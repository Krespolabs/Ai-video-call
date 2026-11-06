#!/usr/bin/env node
/**
 * Backfill custodial Solana wallets for all existing agent identities that
 * are linked to an avatar but have no solana_address in their meta JSON.
 *
 * Every new avatar auto-provisions a Solana wallet on creation (api/avatars/index.js).
 * This script catches the gap for agents created before that behavior shipped.
 *
 * Usage:
 *   node scripts/backfill-avatar-wallets.mjs           # live run
 *   node scripts/backfill-avatar-wallets.mjs --dry     # report only, no writes
 *   node scripts/backfill-avatar-wallets.mjs --limit 50
 */
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── tiny .env.local loader ────────────────────────────────────────────────────
(function loadEnvLocal() {
	const p = path.join(process.cwd(), '.env.local');
	if (!fs.existsSync(p)) return;
	for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/i);
		if (!m) continue;
		const k = m[1];
		const v = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
		if (process.env[k] == null || process.env[k] === '') process.env[k] = v;
	}
})();

// ── args ──────────────────────────────────────────────────────────────────────
const DRY = process.argv.includes('--dry');
const LIMIT = (() => {
	const i = process.argv.indexOf('--limit');
	return i !== -1 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : 500;
})();
const CONCURRENCY = 5; // Solana RPC calls in parallel

// ── validate env ─────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
	console.error('ERROR: DATABASE_URL is required. Set it in .env.local or the environment.');
	process.exit(1);
}

const { sql } = await import('../api/_lib/db.js');
const { getOrCreateAgentSolanaWallet } = await import('../api/_lib/agent-wallet.js');

// ── find agents without a Solana wallet ──────────────────────────────────────
const rows = await sql`
	SELECT id, name, avatar_id, user_id,
	       meta->>'solana_address' AS solana_address
	FROM agent_identities
	WHERE avatar_id IS NOT NULL
	  AND deleted_at IS NULL
	  AND (meta IS NULL OR meta->>'solana_address' IS NULL OR meta->>'solana_address' = '')
	ORDER BY created_at ASC
	LIMIT ${LIMIT}
`;

console.log(`Found ${rows.length} agent identities linked to avatars without a Solana wallet`);
if (DRY) {
	console.log('[dry-run] No wallets will be created.');
	for (const row of rows) {
		console.log(`  agent ${row.id}  name="${row.name}"  avatar=${row.avatar_id}`);
	}
	process.exit(0);
}

if (rows.length === 0) {
	console.log('All avatar-linked agents already have Solana wallets. Nothing to do.');
	await sql.end();
	process.exit(0);
}

// ── provision in batches ──────────────────────────────────────────────────────
let created = 0;
let failed = 0;
let skipped = 0;

async function processOne(row) {
	try {
		const wallet = await getOrCreateAgentSolanaWallet(row.id);
		if (wallet.created) {
			console.log(`  ✓ created  agent ${row.id}  address=${wallet.address}`);
			created++;
		} else {
			// Race: another process provisioned between the SELECT and now.
			console.log(`  · exists   agent ${row.id}  address=${wallet.address}`);
			skipped++;
		}
	} catch (err) {
		console.error(`  ✗ failed   agent ${row.id}  error=${err?.message}`);
		failed++;
	}
}

// Process CONCURRENCY agents at a time.
for (let i = 0; i < rows.length; i += CONCURRENCY) {
	const batch = rows.slice(i, i + CONCURRENCY);
	await Promise.all(batch.map(processOne));
	if (i + CONCURRENCY < rows.length) {
		process.stdout.write(`  [${Math.min(i + CONCURRENCY, rows.length)}/${rows.length}] ...`);
		process.stdout.write('\r');
	}
}

console.log('');
console.log('── Results ──────────────────────────────────────────────────────');
console.log(`  Created : ${created}`);
console.log(`  Already existed (skipped) : ${skipped}`);
console.log(`  Failed  : ${failed}`);

await sql.end();
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
/**
 * Backfill custodial Solana wallets for EVERY agent identity that is missing a
 * valid one — not just avatar-linked agents (that narrower case is covered by
 * backfill-avatar-wallets.mjs). This is the paired runner for the migration
 * api/_lib/migrations/20260617000000_agent_wallet_backfill.sql.
 *
 * It provisions through ensureAgentWallet() — the SAME canonical custody path
 * the request handlers use — so the backfill can never diverge from live
 * behavior. ensureAgentWallet() also REPAIRS rows whose address is present but
 * malformed, or whose encrypted secret is missing, so the set this script leaves
 * behind is genuinely "every agent resolvable to a valid Solana wallet".
 *
 * SAFE BY DEFAULT: report-only unless --apply is passed.
 *
 * Usage:
 *   node scripts/backfill-agent-wallets.mjs            # report pending, no writes
 *   node scripts/backfill-agent-wallets.mjs --apply    # provision via ensureAgentWallet()
 *   node scripts/backfill-agent-wallets.mjs --apply --limit 1000
 *
 * Idempotent and re-runnable: a second --apply run is a no-op once every row has
 * a wallet. Secrets are never printed — only the public address.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── tiny .env loader (matches apply-migrations.mjs) ───────────────────────────
for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = fs.readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
			process.env[m[1]] = val;
		}
		break;
	} catch {
		/* file not present */
	}
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = (() => {
	const i = args.indexOf('--limit');
	return i !== -1 && args[i + 1] ? Math.max(1, parseInt(args[i + 1], 10) || 1000) : 5000;
})();
const CONCURRENCY = 4; // keypair gen is CPU-light; cap concurrent DB writes.

if (!process.env.DATABASE_URL) {
	console.error('ERROR: DATABASE_URL is required. Set it in .env.local or the environment.');
	process.exit(1);
}

const { sql } = await import('../api/_lib/db.js');
const { ensureAgentWallet } = await import('../api/_lib/agent-wallet.js');

const rows = await sql`
	SELECT id, name, user_id
	FROM agent_identities
	WHERE deleted_at IS NULL
	  AND (meta IS NULL OR meta->>'solana_address' IS NULL OR meta->>'solana_address' = '')
	ORDER BY created_at ASC
	LIMIT ${LIMIT}
`;

console.log(`Found ${rows.length} agent identit${rows.length === 1 ? 'y' : 'ies'} without a Solana wallet address.`);

if (!APPLY) {
	for (const row of rows) {
		console.log(`  [pending] agent ${row.id}  name="${row.name ?? ''}"`);
	}
	console.log(
		rows.length
			? `\nReport only — re-run with --apply to provision ${rows.length} wallet(s).`
			: '\nNothing to backfill.',
	);
	process.exit(0);
}

if (rows.length === 0) {
	console.log('All agents already have a Solana wallet. Nothing to do.');
	await sql.end?.();
	process.exit(0);
}

let created = 0;
let alreadyHad = 0;
let failed = 0;

async function processOne(row) {
	try {
		const wallet = await ensureAgentWallet(row.id, row.user_id, { reason: 'backfill' });
		if (wallet.created) {
			created++;
			console.log(`  ✓ provisioned  agent ${row.id}  address=${wallet.address}`);
		} else {
			// Race: another process provisioned between the SELECT and now.
			alreadyHad++;
			console.log(`  · exists       agent ${row.id}  address=${wallet.address}`);
		}
	} catch (err) {
		failed++;
		console.error(`  ✗ failed       agent ${row.id}  error=${err?.message}`);
	}
}

for (let i = 0; i < rows.length; i += CONCURRENCY) {
	await Promise.all(rows.slice(i, i + CONCURRENCY).map(processOne));
}

console.log('\n── Results ──────────────────────────────────────────────────────');
console.log(`  Provisioned : ${created}`);
console.log(`  Already had : ${alreadyHad}`);
console.log(`  Failed      : ${failed}`);

// Verify zero rows remain (the success criterion). A non-empty remainder after a
// full run means some provisions failed — surface a non-zero exit for CI/ops.
const [{ remaining }] = await sql`
	SELECT COUNT(*)::int AS remaining
	FROM agent_identities
	WHERE deleted_at IS NULL
	  AND (meta IS NULL OR meta->>'solana_address' IS NULL OR meta->>'solana_address' = '')
`;
console.log(`  Remaining   : ${remaining}`);

await sql.end?.();
process.exit(failed > 0 || remaining > 0 ? 1 : 0);

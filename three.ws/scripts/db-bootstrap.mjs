#!/usr/bin/env node
/**
 * One-command database bootstrap / heal.
 *
 * Brings an empty or partially-provisioned Postgres (Neon) database fully up to
 * date by running every schema step in dependency order. Each step is idempotent
 * and reads DATABASE_URL itself, so this is safe to re-run any time — on a fresh
 * production database it provisions the entire schema; on a live one it is a no-op
 * for everything already applied.
 *
 * Order matters:
 *   1. Core schema      (api/_lib/schema.sql)        — agents, users, avatars,
 *                                                       agent_identities, sessions,
 *                                                       widgets, usage_events, …
 *   2. Indexer schema   (specs/schema/indexer_state.sql)
 *   3. Delegation schema(specs/schema/agent_delegations.sql)
 *   4. Migrations       (api/_lib/migrations/*.sql)  — every incremental table:
 *                                                       agent_custody_events,
 *                                                       forge_creations, x_triggers,
 *                                                       pump_coin_intel, club_tips,
 *                                                       unstoppable_* …
 *
 * Steps 1–3 must precede step 4 because later migrations ALTER tables those base
 * files create.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node scripts/db-bootstrap.mjs   # apply everything
 *   npm run db:bootstrap                                      # same, via package.json
 *
 * Reads DATABASE_URL from .env.local → .env → process env (same as every step).
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnvFile(path) {
	let raw;
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		return;
	}
	for (const line of raw.split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
		if (!m) continue;
		const [, k, v] = m;
		if (process.env[k]) continue;
		process.env[k] = v.replace(/^["']|["']$/g, '');
	}
}
loadEnvFile(resolve(root, '.env.local'));
loadEnvFile(resolve(root, '.env'));

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL not set. Add it to .env.local or export it before running.');
	process.exit(1);
}

const host = (() => {
	try {
		return new URL(process.env.DATABASE_URL).host;
	} catch {
		return '<DATABASE_URL>';
	}
})();

const STEPS = [
	{ name: 'Core schema', cmd: ['node', 'scripts/apply-schema.mjs'] },
	{ name: 'Indexer state', cmd: ['node', 'scripts/apply-indexer-schema.js'] },
	{ name: 'Agent delegations', cmd: ['node', 'scripts/apply-delegations-schema.js'] },
	{ name: 'Migrations', cmd: ['node', 'scripts/apply-migrations.mjs', '--apply'] },
];

function run({ name, cmd }) {
	return new Promise((resolveStep, rejectStep) => {
		console.log(`\n━━ ${name} ━━`);
		const child = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit', env: process.env });
		child.on('error', rejectStep);
		child.on('close', (code) => {
			if (code === 0) resolveStep();
			else rejectStep(new Error(`${name} exited with code ${code}`));
		});
	});
}

console.log(`Bootstrapping database schema on ${host} …`);

for (const step of STEPS) {
	try {
		await run(step);
	} catch (err) {
		console.error(`\n✗ ${err.message}`);
		console.error('Bootstrap halted. Fix the error above and re-run — completed steps are idempotent.');
		process.exit(1);
	}
}

console.log('\n✓ Database fully bootstrapped — all schema and migrations applied.');

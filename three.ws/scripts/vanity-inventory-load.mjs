#!/usr/bin/env node
/**
 * Load a batch grinder's ENCRYPTED inventory JSONL into the vanity_inventory
 * table, and housekeeping for the store.
 *
 * The JSONL is produced by workers/vanity-grinder/grind.mjs. Each line already
 * holds a SEALED secret (secret_ciphertext) — this loader never sees or writes a
 * plaintext key; it just upserts records. Run it wherever DATABASE_URL points at
 * the target DB (locally against a Neon branch, or in CI/prod).
 *
 * Usage:
 *   node scripts/vanity-inventory-load.mjs --file workers/vanity-grinder/out/inventory.jsonl
 *   node scripts/vanity-inventory-load.mjs --file <f> --dry-run
 *   node scripts/vanity-inventory-load.mjs --stats
 *   node scripts/vanity-inventory-load.mjs --sweep      # destroy expired ciphertext
 *
 * Auth: reads DATABASE_URL from .env / .env.local / env. No interactive prompts.
 * The vault key (WALLET_ENCRYPTION_KEY / VANITY_KMS_KEY) is NOT needed here — the
 * loader stores ciphertext as-is; only the delivery endpoint ever decrypts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// Load .env.local / .env like scripts/apply-migrations.mjs.
for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
			process.env[m[1]] = val;
		}
		break;
	} catch { /* not present */ }
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const DRY = has('--dry-run');

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is not set. Add it to .env.local or export it.');
	process.exit(2);
}

const store = await import('../api/_lib/vanity-inventory-store.js');

if (has('--stats')) {
	const s = await store.inventoryStats();
	console.log(JSON.stringify(s, null, 2));
	process.exit(0);
}

if (has('--sweep')) {
	const r = await store.sweepExpiredSecrets();
	console.log(`Swept ${r.destroyed} expired ciphertext(s).`);
	process.exit(0);
}

const file = val('--file');
if (!file) {
	console.error('Usage: --file <inventory.jsonl> | --stats | --sweep');
	process.exit(2);
}

const lines = readFileSync(path.resolve(file), 'utf8').trim().split('\n').filter(Boolean);
console.log(`Loading ${lines.length} record(s) from ${file}${DRY ? ' (dry-run)' : ''}…`);

let inserted = 0, skipped = 0, bad = 0;
for (const line of lines) {
	let r;
	try {
		r = JSON.parse(line);
	} catch {
		bad++;
		continue;
	}
	if (!r.address || !r.secretCiphertext) { bad++; continue; }
	if (DRY) { inserted++; continue; }
	try {
		const res = await store.upsertInventoryItem({
			address: r.address,
			prefix: r.prefix,
			suffix: r.suffix,
			ignoreCase: r.ignoreCase,
			patternLabel: r.patternLabel,
			format: r.format,
			difficultyAttempts: r.difficultyAttempts,
			rarityBits: r.rarityBits,
			rarityTier: r.rarityTier,
			rarityScore: r.rarityScore,
			secretCiphertext: r.secretCiphertext,
			secretScheme: r.secretScheme,
			priceUsd: r.priceUsd,
			retentionDays: r.retentionDays ?? 0,
		});
		res.inserted ? inserted++ : skipped++;
	} catch (err) {
		console.error(`  ! ${r.address}: ${err.message}`);
		bad++;
	}
}

console.log(`Done. inserted=${inserted} skipped(existing)=${skipped} bad=${bad}`);
if (!DRY) {
	const s = await store.inventoryStats();
	console.log(`Inventory now: ${s.available} available, ${s.sold} sold, price $${s.minPrice}–$${s.maxPrice}.`);
}
process.exit(0);

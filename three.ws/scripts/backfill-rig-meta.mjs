#!/usr/bin/env node
// Backfill the rig classifier signal (source_meta.is_rigged + skeleton stats)
// for avatars that predate the classifier or were direct uploads — i.e. any row
// whose source_meta never recorded whether the GLB carries a skeleton.
//
// The gallery's Rig filter, per-card "Rigged / Not rigged" badge, and "Rigged
// first" sort all read source_meta via the shared classifier
// (src/shared/rig-classify.js). New uploads now self-classify at create time
// (api/avatars/index.js → handleCreate); this script lights up the existing
// catalog the same way.
//
// Uses the exact same access layer the API uses (api/_lib/db.js +
// api/_lib/rig-inspect.js), so what this writes is precisely what the gallery
// reads. Only the GLB's glTF JSON chunk is read via a ranged request — never the
// mesh binary — so a large catalog is cheap to scan.
//
// Safety properties:
//   • Idempotent + resume-safe — only rows missing source_meta.is_rigged are
//     touched; a re-run after a crash continues where it left off.
//   • Throttled — bounded concurrency via a simple per-row delay.
//   • --dry-run prints what would change and writes NOTHING.
//   • Fail-open per row — an unreadable / non-GLB object is left untouched
//     (stays "unknown") and the run continues.
//
// Usage:
//   node scripts/backfill-rig-meta.mjs --dry-run
//   node scripts/backfill-rig-meta.mjs [--limit 1000] [--throttle-ms 50]
//
// Requires DATABASE_URL (+ S3/R2 credentials for bucket-backed objects) from
// .env.local / .env / the environment.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function parseArgs(argv) {
	const get = (name, dflt) => {
		const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
		if (!hit) return dflt;
		if (hit === `--${name}`) return true;
		return hit.split('=').slice(1).join('=');
	};
	return {
		dryRun: get('dry-run', false) === true,
		limit: Number(get('limit', 1000)) || 1000,
		throttleMs: Number(get('throttle-ms', 50)) || 50,
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	loadEnvFile(resolve(root, '.env.local'));
	loadEnvFile(resolve(root, '.env'));

	const args = parseArgs(process.argv.slice(2));

	if (!process.env.DATABASE_URL) {
		console.error('DATABASE_URL is required.');
		process.exit(1);
	}

	const { sql } = await import(pathToFileURL(resolve(root, 'api/_lib/db.js')));
	const { inspectStorageKeyRig } = await import(
		pathToFileURL(resolve(root, 'api/_lib/rig-inspect.js'))
	);

	// Rows never skeleton-inspected: no is_rigged key in source_meta. A positive
	// skeleton_joint_count without the flag is already classified rigged, so it
	// doesn't need a backfill — the `is_rigged` key absence is the precise signal.
	const rows = await sql`
		select id, name, storage_key
		from avatars
		where deleted_at is null
		  and storage_key is not null
		  and (source_meta is null or not (source_meta ? 'is_rigged'))
		order by created_at desc
		limit ${args.limit}
	`;

	console.log(
		`Found ${rows.length} avatar(s) without a rig signal (limit ${args.limit}).`,
	);
	if (rows.length === 0) return;

	if (args.dryRun) {
		for (const r of rows.slice(0, 20)) {
			console.log(`  would inspect: ${r.id}  "${r.name}"  (${r.storage_key})`);
		}
		if (rows.length > 20) console.log(`  …and ${rows.length - 20} more`);
		console.log('\nDry run — nothing written. Re-run without --dry-run to apply.');
		return;
	}

	let rigged = 0;
	let staticCount = 0;
	let skipped = 0;
	for (const r of rows) {
		let rig = null;
		try {
			rig = await inspectStorageKeyRig(r.storage_key);
		} catch (e) {
			console.warn(`  ! ${r.id} inspect error: ${e?.message}`);
		}
		if (rig) {
			// Merge so any other source_meta fields are preserved.
			await sql`
				update avatars
				set source_meta = coalesce(source_meta, '{}'::jsonb) || ${JSON.stringify(rig)}::jsonb
				where id = ${r.id}
			`;
			if (rig.is_rigged) rigged++;
			else staticCount++;
			console.log(
				`  ✓ ${r.id}  ${rig.is_rigged ? 'RIGGED' : 'static'} (${rig.skeleton_joint_count} joints)  "${r.name}"`,
			);
		} else {
			skipped++;
			console.log(`  · ${r.id} left unknown (not a readable GLB)`);
		}
		await sleep(args.throttleMs);
	}

	console.log(
		`\nDone. ${rigged} rigged, ${staticCount} static, ${skipped} left unknown, ${rows.length} processed.`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

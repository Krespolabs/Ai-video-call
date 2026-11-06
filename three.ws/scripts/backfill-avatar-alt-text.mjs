#!/usr/bin/env node
// Backfill accessibility alt text for public avatars that have a thumbnail but
// no generated alt text yet (T4.1, Consumer 3 of the shared vision helper).
//
// Uses the same access layer the API uses (api/_lib/db.js + the shared vision
// helper api/_lib/avatar-alt-text.js), so what this writes is exactly what the
// gallery reads. Each avatar's thumbnail is passed to a free NIM vision lane;
// the resulting one-line description is stored in avatars.alt_text.
//
// Safety properties:
//   • Idempotent + resume-safe — only rows with a thumbnail and a NULL alt_text
//     are touched; a re-run after a crash continues where it left off.
//   • Throttled, with bounded retry — the free tier is credit-metered.
//   • --dry-run prints what would change and writes NOTHING.
//   • Fail-open per row — a row whose thumbnail can't be described is left NULL
//     (gallery falls back to the name) and the run continues.
//
// Usage:
//   node scripts/backfill-avatar-alt-text.mjs --dry-run
//   node scripts/backfill-avatar-alt-text.mjs [--limit 500] [--throttle-ms 300]
//
// Requires DATABASE_URL (+ NVIDIA_API_KEY for a real run) from .env.local /
// .env / the environment. Run AFTER the alt_text column is deployed
// (api/_lib/migrations/2026-06-11-avatar-alt-text.sql).

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
		limit: Number(get('limit', 500)) || 500,
		throttleMs: Number(get('throttle-ms', 300)) || 300,
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
	if (!args.dryRun && !process.env.NVIDIA_API_KEY && !process.env.OPENAI_API_KEY) {
		console.error('A real run needs NVIDIA_API_KEY (free) or OPENAI_API_KEY (backstop). Use --dry-run to preview.');
		process.exit(1);
	}

	// Import the API access layer + shared helpers only after env is loaded.
	const { sql } = await import(pathToFileURL(resolve(root, 'api/_lib/db.js')));
	const { publicUrl } = await import(pathToFileURL(resolve(root, 'api/_lib/r2.js')));
	const { generateAltText } = await import(pathToFileURL(resolve(root, 'api/_lib/avatar-alt-text.js')));

	const rows = await sql`
		select id, name, thumbnail_key
		from avatars
		where deleted_at is null
		  and thumbnail_key is not null
		  and alt_text is null
		order by created_at desc
		limit ${args.limit}
	`;

	console.log(`Found ${rows.length} avatar(s) with a thumbnail and no alt text (limit ${args.limit}).`);
	if (rows.length === 0) return;

	if (args.dryRun) {
		for (const r of rows.slice(0, 20)) {
			console.log(`  would describe: ${r.id}  "${r.name}"  (${r.thumbnail_key})`);
		}
		if (rows.length > 20) console.log(`  …and ${rows.length - 20} more`);
		console.log('\nDry run — nothing written. Re-run without --dry-run to apply.');
		return;
	}

	let written = 0;
	let skipped = 0;
	for (const r of rows) {
		let alt = null;
		try {
			alt = await generateAltText({ imageUrl: publicUrl(r.thumbnail_key), name: r.name });
		} catch (e) {
			console.warn(`  ! ${r.id} generation error: ${e?.message}`);
		}
		if (alt) {
			await sql`update avatars set alt_text = ${alt} where id = ${r.id}`;
			written++;
			console.log(`  ✓ ${r.id}  "${alt}"`);
		} else {
			skipped++;
			console.log(`  · ${r.id} left null (vision unavailable or undescribable)`);
		}
		await sleep(args.throttleMs);
	}

	console.log(`\nDone. ${written} written, ${skipped} left null, ${rows.length} processed.`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

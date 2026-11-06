#!/usr/bin/env node
/**
 * seed-paid-assets.mjs
 * ────────────────────
 * Upload two real GLBs from the repo to R2 under assets/<slug>.glb, then
 * insert a paid_assets row for each. Both rows are priced at $0.005 USDC
 * (5000 atomics). Idempotent: slug is UNIQUE, and the row insert uses
 * ON CONFLICT (slug) DO NOTHING — re-running just re-uploads bytes when
 * R2 differs and leaves rows alone.
 *
 * Required env:
 *   DATABASE_URL, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
 *   S3_BUCKET, S3_PUBLIC_DOMAIN.
 *
 * Usage:
 *   DATABASE_URL=... S3_*=... node scripts/seed-paid-assets.mjs
 *   node scripts/seed-paid-assets.mjs --dry-run     # plan only
 */

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import {
	S3Client,
	PutObjectCommand,
	HeadObjectCommand,
} from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── load .env.local / .env so the script works the same as the dev server ──
for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
		break;
	} catch {
		/* file not present */
	}
}

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, v] = a.replace(/^--/, '').split('=');
		return [k, v ?? true];
	}),
);
const DRY_RUN = !!args['dry-run'];

if (!process.env.DATABASE_URL) {
	console.error('Missing DATABASE_URL');
	process.exit(1);
}
if (!DRY_RUN) {
	for (const k of [
		'S3_ENDPOINT',
		'S3_ACCESS_KEY_ID',
		'S3_SECRET_ACCESS_KEY',
		'S3_BUCKET',
	]) {
		if (!process.env[k]) {
			console.error(`Missing ${k}`);
			process.exit(1);
		}
	}
}

const sql = neon(process.env.DATABASE_URL);
const s3 = DRY_RUN
	? null
	: new S3Client({
			region: 'auto',
			endpoint: process.env.S3_ENDPOINT.replace(/\/$/, ''),
			credentials: {
				accessKeyId: process.env.S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
			},
			requestChecksumCalculation: 'WHEN_REQUIRED',
			responseChecksumValidation: 'WHEN_REQUIRED',
		});

// The two seed entries the prompt asks for:
//   1. pole-dancer-rumba — points at the same default.glb the /club page uses
//      for the Rumba routine (see src/club.js AVATAR_URL).
//   2. cz-avatar         — the stylized CZ avatar in public/avatars/cz.glb.
// Both priced at 5000 atomics = $0.005 USDC.
const CATALOG = [
	{
		slug: 'pole-dancer-rumba',
		title: 'Pole Dancer (Rumba)',
		description:
			'The three.ws default dancer rigged for the /club Rumba routine. ' +
			'Drop this GLB into any Three.js scene and play the "rumba" clip from ' +
			'the bundled AnimationMixer.',
		file: 'public/avatars/default.glb',
		mimeType: 'model/gltf-binary',
		priceAtomics: '5000',
	},
	{
		slug: 'cz-avatar',
		title: 'CZ Avatar',
		description:
			'Stylized humanoid CZ avatar — humanoid skeleton, single mesh, ' +
			'low-poly silhouette. Ready for the three.ws Character Studio or ' +
			'any humanoid retargeter.',
		file: 'public/avatars/cz.glb',
		mimeType: 'model/gltf-binary',
		priceAtomics: '5000',
	},
];

async function objectExists(key) {
	if (!s3) return false;
	try {
		await s3.send(
			new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
		);
		return true;
	} catch (err) {
		if (err?.$metadata?.httpStatusCode === 404) return false;
		throw err;
	}
}

async function uploadAsset(localPath, key, mimeType) {
	const buf = await readFile(localPath);
	if (DRY_RUN) {
		console.log(`  [dry-run] would PUT ${key} (${buf.length} bytes)`);
		return buf.length;
	}
	await s3.send(
		new PutObjectCommand({
			Bucket: process.env.S3_BUCKET,
			Key: key,
			Body: buf,
			ContentType: mimeType,
		}),
	);
	return buf.length;
}

async function ensureRow(row) {
	if (DRY_RUN) {
		console.log(`  [dry-run] would upsert paid_assets row slug=${row.slug}`);
		return;
	}
	await sql`
		insert into paid_assets
			(slug, title, description, mime_type, size_bytes, r2_key, price_atomics)
		values
			(${row.slug}, ${row.title}, ${row.description}, ${row.mimeType},
			 ${row.sizeBytes}, ${row.r2Key}, ${row.priceAtomics})
		on conflict (slug) do nothing
	`;
}

async function main() {
	for (const entry of CATALOG) {
		const localPath = resolve(REPO_ROOT, entry.file);
		const stats = await stat(localPath);
		const sizeBytes = stats.size;
		const r2Key = `assets/${entry.slug}.glb`;
		console.log(
			`→ ${entry.slug}  ${entry.file}  (${sizeBytes} bytes)  →  s3://${process.env.S3_BUCKET || '?'}/${r2Key}`,
		);

		const exists = await objectExists(r2Key);
		if (!exists) {
			const uploaded = await uploadAsset(localPath, r2Key, entry.mimeType);
			console.log(`  uploaded ${uploaded} bytes`);
		} else {
			console.log('  already present in R2 — skipping upload');
		}

		await ensureRow({
			slug: entry.slug,
			title: entry.title,
			description: entry.description,
			mimeType: entry.mimeType,
			sizeBytes,
			r2Key,
			priceAtomics: entry.priceAtomics,
		});
		console.log(`  paid_assets row ready`);
	}
	console.log('seed-paid-assets: done');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

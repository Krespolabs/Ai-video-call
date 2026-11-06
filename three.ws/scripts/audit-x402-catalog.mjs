#!/usr/bin/env node
/**
 * x402 endpoint-catalog drift guard.
 *
 * Every paid HTTP endpoint under api/x402/ is a sellable product an agent can
 * discover and pay for — so every one MUST appear in the public catalog at
 * docs/x402-endpoints.md. This is exactly the drift that let 18 endpoints ship
 * undocumented: a new handler lands, nobody updates the catalog, and buyers
 * can't find it. This guard fails the build when an endpoint file has no
 * corresponding mention in the catalog, by its slug.
 *
 * Invariant: for each `api/x402/<slug>.js`, the string `<slug>` appears
 * somewhere in docs/x402-endpoints.md (typically as a `/api/x402/<slug>` row).
 * That keeps the check wiring-agnostic — it doesn't care HOW an endpoint
 * declares its price, only that it is catalogued.
 *
 * Excluded (not buyer-facing endpoints):
 *   - *.test.js / *.spec.js
 *   - shared helpers in nested dirs (only top-level api/x402/*.js are routes)
 *
 * Usage:
 *   node scripts/audit-x402-catalog.mjs    # exit 1 if any endpoint is undocumented
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const X402_DIR = resolve(root, 'api', 'x402');
const CATALOG = resolve(root, 'docs', 'x402-endpoints.md');

// Top-level route files only — nested dirs hold shared helpers, not routes.
const slugs = readdirSync(X402_DIR, { withFileTypes: true })
	.filter((e) => e.isFile() && e.name.endsWith('.js') && !/\.(test|spec)\.js$/.test(e.name))
	.map((e) => e.name.replace(/\.js$/, ''));

const catalog = readFileSync(CATALOG, 'utf8');

const undocumented = slugs.filter((slug) => !catalog.includes(slug));

if (undocumented.length) {
	console.error(
		`\n✗ ${undocumented.length} x402 endpoint(s) missing from docs/x402-endpoints.md:\n`,
	);
	for (const slug of undocumented) console.error(`  /api/x402/${slug}`);
	console.error(
		'\nEvery api/x402/*.js endpoint must be listed in the catalog (docs/x402-endpoints.md).\n' +
			'Add a row with its slug, default price, and what it returns — see the existing tables.\n',
	);
	process.exit(1);
}

console.log(`✓ audit-x402-catalog: all ${slugs.length} x402 endpoints are documented`);

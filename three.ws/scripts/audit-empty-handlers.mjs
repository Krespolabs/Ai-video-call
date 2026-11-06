#!/usr/bin/env node
/**
 * Empty / no-export API handler guard.
 *
 * The api/ tree uses a dispatcher-shim pattern where a real endpoint can be a
 * very thin file, so a zero-byte or export-less file looks normal and slips
 * through review — exactly how `api/agents/[id]/skill-collection.js` sat as a
 * 1-byte dead endpoint. Vercel's filesystem routing makes such a file
 * *reachable* but it can never serve a response. This guard fails the build if
 * any JavaScript file under api/ is empty or exports nothing.
 *
 * A file is flagged when:
 *   - it is empty / whitespace-only (< 2 non-space bytes), OR
 *   - it contains no ESM `export` and no CommonJS `module.exports`.
 *
 * Excluded (legitimately have no export):
 *   - *.test.js / *.spec.js — vitest files use describe/it, not exports.
 *   - *.d.ts and non-.js files — not handlers.
 *
 * Usage:
 *   node scripts/audit-empty-handlers.mjs    # exit 1 if any offender is found
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = resolve(root, 'api');

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith('.js') && !/\.(test|spec)\.js$/.test(entry.name)) out.push(full);
	}
	return out;
}

const EXPORT_RE = /(^|\s)export\s|export\s*\{|export\s*\*|module\.exports/;

const offenders = [];
for (const file of walk(API_DIR)) {
	const src = readFileSync(file, 'utf8');
	const rel = file.slice(root.length + 1);
	if (src.trim().length < 2) offenders.push([rel, 'empty file']);
	else if (!EXPORT_RE.test(src)) offenders.push([rel, 'no export / module.exports']);
}

if (offenders.length) {
	console.error(`\n✗ ${offenders.length} unreachable/empty API handler file(s):\n`);
	for (const [rel, why] of offenders) console.error(`  ${rel} — ${why}`);
	console.error('\nEvery api/**/*.js file must export a handler. Delete dead files or implement them.\n');
	process.exit(1);
}

console.log(`✓ audit-empty-handlers: all API handlers export a body (${walk(API_DIR).length} checked)`);

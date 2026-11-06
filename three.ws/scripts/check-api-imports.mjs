#!/usr/bin/env node
/**
 * API import sweep: does every module under api/ load?
 *
 * Why this exists
 * ---------------
 * The Cloud Run server imports a handler the first time its route is hit, so a
 * module that throws while loading is not a build error and not a boot error.
 * It is a 500 on every request to that route, found later in stderr. One bad
 * shared module takes down everything that imports it:
 *
 *   · 2026-09-18: @x402/extensions 2.25.0 made `origin` a required option and
 *     throws at construction without it. api/_lib/siwx-server.js built the
 *     extension at module load, so every paidEndpoint() route, /api/mcp, the
 *     facilitator and /.well-known/x402 answered 500.
 *   · Same day, same dependabot batch: @bnb-chain/mpp 0.7.0 dropped its
 *     './b402/server' export, so api/_lib/bnb/mpp-server.js failed with
 *     ERR_PACKAGE_PATH_NOT_EXPORTED and the BSC rail went with it.
 *
 * Both were invisible to a test suite running on a stale node_modules, and both
 * are caught here in under a minute regardless of cause: a renamed export, a
 * deleted file, a dependency that changed shape, a top-level throw.
 *
 * What it does
 * ------------
 * Imports every api/**∕*.js (tests and vitest configs excluded) in this process
 * and reports each one that throws, grouped by error so one root cause reads as
 * one finding. Handlers read their configuration per request, not at load, so
 * this needs no environment: it passes with no `.env` at all, and a module that
 * starts demanding env at import time is itself a finding.
 *
 * Usage:
 *   node scripts/check-api-imports.mjs            # whole api/ tree
 *   node scripts/check-api-imports.mjs api/x402   # one subtree
 *
 * Exit code 0 when everything loads, 1 otherwise. Wired into
 * `npm run deploy:gcp:submit` ahead of the Cloud Build upload.
 */
import { globSync } from 'glob';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function listApiModules({ root = ROOT, subtree = 'api' } = {}) {
	return globSync('**/*.js', {
		cwd: resolve(root, subtree),
		absolute: true,
		ignore: ['**/*.test.js', '**/vitest.config.js', '**/node_modules/**'],
	}).sort();
}

function describeFailure(err) {
	const label = err?.code || err?.name || 'Error';
	const firstLine = String(err?.message ?? err).split('\n')[0];
	return `${label}: ${firstLine}`;
}

/**
 * Imports each file and returns the failures grouped by error text:
 * `[{ error, files: [...] }]`, most widespread first.
 */
export async function findBrokenImports(files, { root = ROOT } = {}) {
	const byError = new Map();
	for (const file of files) {
		try {
			await import(pathToFileURL(file).href);
		} catch (err) {
			const error = describeFailure(err);
			if (!byError.has(error)) byError.set(error, []);
			byError.get(error).push(relative(root, file));
		}
	}
	return [...byError.entries()]
		.map(([error, failed]) => ({ error, files: failed }))
		.sort((a, b) => b.files.length - a.files.length);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const start = Date.now();
	const subtree = process.argv[2] || 'api';
	const files = listApiModules({ subtree });
	if (!files.length) {
		console.error(`[check:api-imports] FAIL: no modules found under ${subtree}/`);
		process.exit(1);
	}

	// Modules log while loading. Keep that out of the report so a failure is the
	// only thing on screen.
	const quiet = () => {};
	const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
	Object.assign(console, { log: quiet, info: quiet, warn: quiet, error: quiet });
	const broken = await findBrokenImports(files);
	Object.assign(console, original);

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	if (broken.length) {
		const total = broken.reduce((sum, group) => sum + group.files.length, 0);
		console.error(
			`[check:api-imports] FAIL: ${total} of ${files.length} module(s) under ${subtree}/ throw while loading. Each one is a 500 on every request to its route:`,
		);
		for (const { error, files: failed } of broken) {
			console.error(`\n  ${failed.length}x ${error}`);
			for (const file of failed.slice(0, 8)) console.error(`     ${file}`);
			if (failed.length > 8) console.error(`     ... and ${failed.length - 8} more`);
		}
		console.error(
			`\n[check:api-imports] failed in ${elapsed}s. A dependency error usually means node_modules is behind package-lock.json (run \`npm install\`) or a bump changed an API. An ENOENT under data/_generated/ means the build has not run in this tree: that directory is written by \`prebuild\`, which is why this gate sits after build:gcp.`,
		);
		process.exit(1);
	}
	console.log(`[check:api-imports] clean in ${elapsed}s: all ${files.length} module(s) under ${subtree}/ load`);
	// Loaded modules can hold timers and sockets open; the verdict is in, so leave.
	process.exit(0);
}

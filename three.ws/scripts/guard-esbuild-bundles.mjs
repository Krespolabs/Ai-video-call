#!/usr/bin/env node
/**
 * esbuild-trap guard — refuse to commit a bundled api/*.js source file.
 *
 * The trap (CLAUDE.md "Known traps"): `npx vercel build` and
 * scripts/bundle-api.mjs both esbuild every api route and write the bundle back
 * over the source with `--outdir=api --allow-overwrite`. On Vercel that's fine —
 * the checkout is ephemeral. Locally it destroys the hand-written route sources,
 * and if one of those multi-thousand-line bundles gets `git add`ed and committed
 * the repo balloons (commits c94190b3 and dabd5884 — both reverted) and the real
 * source is lost. The bundles are unmistakable: their first lines carry esbuild's
 * `__defProp`/`__commonJS`/`__toESM` helpers or the bundle-api `createRequire`
 * banner, neither of which ever appears at the top of a hand-written route.
 *
 * This guard scans the *staged* content of api JS files (what a commit would
 * actually record, not just the working tree) and exits non-zero if any of them
 * is a bundle. Wire it as a pre-commit check (see docs/build.md) so the bundle
 * can never be committed by accident.
 *
 * Usage:
 *   node scripts/guard-esbuild-bundles.mjs            # scan staged api JS (pre-commit)
 *   node scripts/guard-esbuild-bundles.mjs --all      # sweep every working-tree api JS
 *   node scripts/guard-esbuild-bundles.mjs --files a.js b.js   # scan explicit paths
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Markers that only an esbuild/bundle-api output carries near the top of the
// file. `__defProp`, `__commonJS`, `__toESM`, `__esm` are esbuild's CJS/ESM
// interop helpers; `createRequire` is the bundle-api `--banner:js` shim; the
// bare `esbuild` token catches the `// esbuild` provenance comments some
// configs emit. None of these appear in the opening lines of a hand-authored
// Vercel route (verified across all 1100+ api/**/*.js files), so a hit is an
// unambiguous bundle.
const BUNDLE_MARKER = /\b(?:__defProp|__commonJS|__toESM|__esm|createRequire|esbuild)\b/;

// Bundles announce themselves immediately. esbuild emits an optional
// `"use strict";` line before `var __defProp = ...`, and bundle-api's banner is
// line 1 — so the markers always land within the first handful of lines.
// Scanning only the head (not the whole multi-MB file) keeps this fast and makes
// a false positive on a legitimate deep-in-the-file occurrence impossible.
const HEAD_LINES = 5;

/**
 * Returns the matched bundle marker (string) if `content` looks like an esbuild
 * bundle, or null if it reads as hand-written source.
 */
export function detectBundleMarker(content) {
	const head = content.split('\n', HEAD_LINES).join('\n');
	const m = head.match(BUNDLE_MARKER);
	return m ? m[0] : null;
}

function isApiJs(rel) {
	const norm = rel.replace(/\\/g, '/');
	return /^api\//.test(norm) && norm.endsWith('.js');
}

/** Paths (repo-relative) of api JS files in the git index, added/copied/modified. */
function stagedApiJsFiles(cwd) {
	let out;
	try {
		out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch {
		return [];
	}
	return out.split('\n').filter(Boolean).filter(isApiJs);
}

/** Reads the *staged* blob of a path (`git show :path`); null if absent from index. */
function readStagedBlob(rel, cwd) {
	try {
		return execFileSync('git', ['show', `:${rel}`], {
			cwd,
			encoding: 'utf8',
			maxBuffer: 256 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch {
		return null;
	}
}

/** Every working-tree api JS file (repo-relative). */
function allApiJsFiles(cwd) {
	return globSync('api/**/*.js', { cwd, ignore: ['**/node_modules/**'] }).sort();
}

/**
 * Scans the given (path → content) pairs and returns the ones that are bundles.
 * Exported for tests; the CLI wires it to either staged blobs or working-tree
 * files.
 */
export function findBundledFiles(entries) {
	const hits = [];
	for (const { path, content } of entries) {
		if (content == null) continue;
		const marker = detectBundleMarker(content);
		if (marker) hits.push({ path, marker });
	}
	return hits;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const args = process.argv.slice(2);
	const cwd = ROOT;
	let entries;
	let mode;

	const fileFlagIdx = args.indexOf('--files');
	if (fileFlagIdx !== -1) {
		mode = 'explicit';
		const files = args.slice(fileFlagIdx + 1).filter((a) => !a.startsWith('--'));
		entries = files.map((path) => {
			let content = null;
			try {
				content = readFileSync(resolve(cwd, path), 'utf8');
			} catch {
				/* unreadable — skip */
			}
			return { path, content };
		});
	} else if (args.includes('--all')) {
		mode = 'working tree';
		entries = allApiJsFiles(cwd).map((path) => {
			let content = null;
			try {
				content = readFileSync(resolve(cwd, path), 'utf8');
			} catch {
				/* unreadable — skip */
			}
			return { path, content };
		});
	} else {
		mode = 'staged';
		entries = stagedApiJsFiles(cwd).map((path) => ({ path, content: readStagedBlob(path, cwd) }));
	}

	const hits = findBundledFiles(entries);
	if (hits.length) {
		console.error(
			`[guard:esbuild] BLOCKED — ${hits.length} bundled api file(s) detected (${mode}). These are esbuild/bundle-api output overwriting hand-written route sources; committing them destroys the source and balloons the repo:`,
		);
		for (const { path, marker } of hits) {
			console.error(`  ${path}  (matched "${marker}")`);
		}
		console.error(
			'\nRecover the real sources before committing:\n' +
				'  git restore --staged -- api/ public/   # unstage the bundles\n' +
				'  git restore -- api/ public/            # restore source from HEAD\n' +
				'See docs/build.md → "The esbuild-overwrite trap".',
		);
		process.exit(1);
	}

	const n = entries.filter((e) => e.content != null).length;
	console.log(`[guard:esbuild] clean — ${n} api JS file(s) scanned (${mode}), no bundles.`);
}

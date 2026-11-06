#!/usr/bin/env node
// i18n-extract — scan annotated HTML and build/refresh the source-of-truth
// catalog (locales/en.json).
//
// three.ws ships copy inline in 150+ static HTML pages, so unlike a greenfield
// i18next app there is no pre-existing key catalog. The migration path is to
// annotate markup incrementally and let this script derive the catalog:
//
//   <h1 data-i18n="home.title">The 3D agent layer of the internet.</h1>
//   <p  data-i18n-html="home.lede">Create <strong>living</strong> agents.</p>
//   <meta name="description" data-i18n-attr="content:home.meta_desc" content="…">
//   <a   data-i18n="common.tour" data-i18n-attr="aria-label:common.tour_aria">Take the tour</a>
//
// The English text already in the element IS the source value — no duplication,
// no drift. Existing values are preserved (annotating a page never clobbers a
// reviewed string); pass --force to overwrite from the current HTML, --prune to
// drop keys no element references anymore.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import { parse } from 'node-html-parser';
import { ROOT, loadConfig, readJSON, setDeep, getDeep, flatten } from './lib/i18n-shared.mjs';

const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Pull every (key, sourceValue) pair out of one HTML document. Pure — operates
// on a string so it is unit-testable without the filesystem.
export function extractFromHtml(html) {
	const root = parse(html, {
		comment: false,
		blockTextElements: { script: false, style: false },
	});
	const found = new Map(); // key → value

	for (const el of root.querySelectorAll('[data-i18n]')) {
		const key = el.getAttribute('data-i18n');
		if (key) found.set(key, collapse(el.text));
	}
	for (const el of root.querySelectorAll('[data-i18n-html]')) {
		const key = el.getAttribute('data-i18n-html');
		if (key) found.set(key, collapse(el.innerHTML));
	}
	for (const el of root.querySelectorAll('[data-i18n-attr]')) {
		// "content:home.meta_desc;aria-label:common.tour_aria"
		for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
			const [attr, key] = pair.split(':').map((s) => s && s.trim());
			if (attr && key) found.set(key, collapse(el.getAttribute(attr)));
		}
	}
	return found;
}

function deepSort(obj) {
	if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
	const out = {};
	for (const k of Object.keys(obj).sort()) out[k] = deepSort(obj[k]);
	return out;
}

async function main() {
	const args = new Set(process.argv.slice(2));
	const FORCE = args.has('--force');
	const PRUNE = args.has('--prune');

	const cfg = loadConfig();
	const entryPath = resolve(ROOT, cfg.entry);
	const existing = readJSON(entryPath, {}) || {};

	const patterns = cfg.htmlExtract?.entry || ['pages/**/*.html', 'public/**/*.html'];
	const ignore = cfg.htmlExtract?.exclude || [];
	const files = (await glob(patterns, { cwd: ROOT, ignore, absolute: true, nodir: true })).sort();

	const catalog = {};
	const seen = new Set();
	const sources = new Map(); // key → first file that defined it
	const collisions = [];
	let added = 0;
	let reused = 0;

	for (const file of files) {
		let pairs;
		try {
			pairs = extractFromHtml(readFileSync(file, 'utf8'));
		} catch (err) {
			console.warn(`! skipped ${relative(ROOT, file)}: ${err.message}`);
			continue;
		}
		for (const [key, value] of pairs) {
			if (seen.has(key)) {
				if (getDeep(catalog, key) !== value) {
					collisions.push(
						`${key}: "${getDeep(catalog, key)}" (${sources.get(key)}) vs "${value}" (${relative(ROOT, file)})`,
					);
				}
				continue;
			}
			seen.add(key);
			sources.set(key, relative(ROOT, file));
			const prior = getDeep(existing, key);
			if (prior !== undefined && !FORCE) {
				setDeep(catalog, key, prior);
				reused++;
			} else {
				setDeep(catalog, key, value);
				added++;
			}
		}
	}

	// Carry over catalog-only keys (strings used from JS via t(), never annotated
	// in HTML) unless --prune is requested.
	if (!PRUNE) {
		for (const [key, value] of Object.entries(flatten(existing))) {
			if (!seen.has(key)) setDeep(catalog, key, value);
		}
	}

	const sorted = deepSort(catalog);
	writeFileSync(entryPath, JSON.stringify(sorted, null, '\t') + '\n');

	const total = Object.keys(flatten(sorted)).length;
	console.log(
		`i18n-extract: ${files.length} files → ${total} keys (${added} new, ${reused} preserved)`,
	);
	if (collisions.length) {
		console.warn(
			`\n⚠ ${collisions.length} key collision(s) — same key, different English text:`,
		);
		for (const c of collisions) console.warn('  ' + c);
		process.exitCode = 1;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

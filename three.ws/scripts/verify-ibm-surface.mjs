#!/usr/bin/env node
// verify-ibm-surface — an executable "is the IBM showcase complete and proper?"
// check for the whole /ibm/* surface.
//
// In a workspace where many agents add pages, engines, endpoints, and routes
// independently, the recurring failure mode is a feature that is *built but not
// wired*: a page ships, but its Vite input, dev route, Vercel route, or its
// front-end engine module is missing — so the page 404s or loads a dead
// <script>. This script makes that class of dead path impossible to miss.
//
// For every pages/ibm/<name>.html it asserts, deterministically and with no
// network:
//   1. engine      — every `/src/*.js` the page loads exists on disk
//   2. viteInput   — the page is a Vite rollup input (so it builds to dist/)
//   3. devRoute    — the Vite dev server maps its clean URL to the page
//   4. vercelRoute — vercel.json rewrites its clean URL (+ trailing slash) to it
// It also flags orphaned `ibm-*` Vite inputs whose page is gone, and inventories
// the api/ibm/*.js endpoints. Exits non-zero if any page is incompletely wired.
//
//   node scripts/verify-ibm-surface.mjs

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => resolve(ROOT, p);
const read = (p) => readFileSync(r(p), 'utf8');

const C = {
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	dim: '\x1b[2m',
	bold: '\x1b[1m',
	reset: '\x1b[0m',
};
const ok = (s) => `${C.green}✓${C.reset} ${s}`;
const no = (s) => `${C.red}✗ ${s}${C.reset}`;

const viteConfig = read('vite.config.js');
const vercelRoutes = JSON.parse(read('vercel.json')).routes || [];

// The clean URL a page is served at: pages/ibm/index.html → /ibm, else /ibm/<name>.
function routeFor(name) {
	return name === 'index' ? '/ibm' : `/ibm/${name}`;
}

// Engines a page pulls in: every `/src/*.js` referenced by a <script src> or import.
function enginesOf(html) {
	const out = new Set();
	for (const m of html.matchAll(/src=["'](\/src\/[^"']+\.js)["']/g)) out.add(m[1]);
	return [...out];
}

function hasViteInput(pagePath) {
	// e.g. resolve(__dirname, 'pages/ibm/galaxy.html')
	return viteConfig.includes(`pages/ibm/${basename(pagePath)}`);
}

function hasDevRoute(route) {
	const q = route.replace(/[/]/g, '\\/');
	// Either a dev fileMap key — '/ibm/galaxy': resolve(root, 'pages/ibm/galaxy.html') —
	// or a configureServer middleware that compares the path: path === '/ibm/x402-demo'
	// (x402-demo is served verbatim by a custom middleware, not the standard fileMap).
	return new RegExp(`['"]${q}['"]\\s*:`).test(viteConfig)
		|| new RegExp(`===?\\s*['"]${q}['"]`).test(viteConfig);
}

function hasVercelRoute(route) {
	const dest = (src) =>
		vercelRoutes.some(
			(x) => x.src === src && typeof x.dest === 'string' && x.dest.includes('/ibm/'),
		);
	// A trailing-slash variant may instead 30x-redirect to the canonical clean URL —
	// the correct shape for a page with RELATIVE assets (./fonts/, ./vendor/), which
	// breaks if the same HTML is served under /<name>/ (the base path shifts).
	const redirectTo = (src, target) =>
		vercelRoutes.some(
			(x) => x.src === src && Number(x.status) >= 300 && Number(x.status) < 400
				&& x.headers && x.headers.Location === target,
		);
	// index maps via /ibm → /ibm/index.html; sub-pages via /ibm/<name> (+ trailing slash).
	if (route === '/ibm') return vercelRoutes.some((x) => x.src === '/ibm');
	const slash = `${route}/`;
	return dest(route) && (dest(slash) || redirectTo(slash, route));
}

const pageDir = 'pages/ibm';
const pages = readdirSync(r(pageDir))
	.filter((f) => f.endsWith('.html'))
	.sort();

let failures = 0;
const rows = [];

for (const file of pages) {
	const name = basename(file, '.html');
	const route = routeFor(name);
	const html = read(`${pageDir}/${file}`);

	const engines = enginesOf(html);
	const missingEngines = engines.filter((e) => !existsSync(r(`.${e}`)));
	const checks = {
		engine: missingEngines.length === 0,
		viteInput: hasViteInput(`${pageDir}/${file}`),
		devRoute: hasDevRoute(route),
		vercelRoute: hasVercelRoute(route),
	};
	const pass = Object.values(checks).every(Boolean);
	if (!pass) failures++;
	rows.push({ name, route, checks, engines, missingEngines, pass });
}

// ── Report ─────────────────────────────────────────────────────────────────
console.log(
	`\n${C.bold}IBM surface integrity — ${pages.length} page(s) under ${pageDir}/${C.reset}\n`,
);
for (const row of rows) {
	const mark = row.pass ? C.green + '●' : C.red + '●';
	console.log(
		`${mark}${C.reset} ${C.bold}${row.route}${C.reset} ${C.dim}(${row.name}.html → ${row.engines.join(', ') || 'no engine'})${C.reset}`,
	);
	const line = [
		row.checks.engine ? ok('engine') : no(`engine missing: ${row.missingEngines.join(', ')}`),
		row.checks.viteInput ? ok('vite input') : no('no vite input'),
		row.checks.devRoute ? ok('dev route') : no('no dev route'),
		row.checks.vercelRoute ? ok('vercel route') : no('no vercel route'),
	].join('   ');
	console.log(`    ${line}`);
}

// Orphaned `ibm-*` Vite inputs whose page file no longer exists.
const orphanInputs = [];
for (const m of viteConfig.matchAll(/['"]pages\/ibm\/([a-z0-9-]+)\.html['"]/g)) {
	const f = `${pageDir}/${m[1]}.html`;
	if (!existsSync(r(f)) && !orphanInputs.includes(f)) orphanInputs.push(f);
}
if (orphanInputs.length) {
	failures += orphanInputs.length;
	console.log(`\n${no('orphaned Vite inputs (page deleted): ' + orphanInputs.join(', '))}`);
}

// Endpoint inventory (informational — not every page maps 1:1 to an endpoint).
const apiDir = 'api/ibm';
if (existsSync(r(apiDir))) {
	const endpoints = readdirSync(r(apiDir))
		.filter((f) => f.endsWith('.js'))
		.map((f) => `/api/ibm/${basename(f, '.js')}`);
	console.log(`\n${C.dim}endpoints: ${endpoints.join(', ')}${C.reset}`);
}

console.log('');
if (failures) {
	console.log(
		`${C.red}${C.bold}✗ ${failures} issue(s) — a built page is not fully reachable.${C.reset}`,
	);
	console.log(
		`${C.dim}  Fix by adding the missing Vite input / dev route (vite.config.js), Vercel route (vercel.json), or the /src engine module.${C.reset}\n`,
	);
	process.exit(1);
}
console.log(
	`${C.green}${C.bold}✓ every /ibm page has an engine, a Vite input, a dev route, and a Vercel route.${C.reset}\n`,
);

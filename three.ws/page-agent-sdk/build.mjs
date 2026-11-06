#!/usr/bin/env node
/**
 * Build @three-ws/page-agent.
 *
 * Two artifacts:
 *   dist/page-agent.mjs        — ESM, `three` left external. For bundler /
 *                                npm consumers who already depend on three.
 *   dist/page-agent.global.js  — IIFE with three + addons inlined, self-
 *                                registers <page-agent> and exposes
 *                                window.ThreeWsPageAgent. For a CDN <script>.
 *   dist/page-agent.css        — the injected stylesheet, materialised for the
 *                                "@three-ws/page-agent/style.css" subpath.
 */

import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSS } from './src/styles.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');
mkdirSync(outDir, { recursive: true });

const common = {
	entryPoints: [resolve(here, 'src/index.js')],
	bundle: true,
	sourcemap: true,
	target: ['es2020'],
	logLevel: 'info',
};

// 1) ESM, three external (peer dependency).
await build({
	...common,
	format: 'esm',
	external: ['three', 'three/addons/*'],
	outfile: resolve(outDir, 'page-agent.mjs'),
});

// 2) Standalone IIFE, three inlined, for a plain CDN <script>.
await build({
	...common,
	format: 'iife',
	globalName: 'ThreeWsPageAgent',
	minify: true,
	outfile: resolve(outDir, 'page-agent.global.js'),
	footer: { js: 'if(typeof window!=="undefined"){window.PageAgent=ThreeWsPageAgent.PageAgent;}' },
});

// 3) Stylesheet for the ./style.css subpath import.
writeFileSync(resolve(outDir, 'page-agent.css'), CSS.trimStart());

console.log('[page-agent] built dist/page-agent.mjs, dist/page-agent.global.js, dist/page-agent.css');

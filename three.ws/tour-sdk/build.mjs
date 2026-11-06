#!/usr/bin/env node
// Build @three-ws/tour into a self-contained, publishable ES module.
// ==================================================================
// esbuild bundles every source module into dist/index.mjs, leaving the two
// peer dependencies external so consumers bring their own copies:
//   · three (+ three/addons/*) — the 3D engine
//   · @three-ws/walk           — the avatar loader the guide reuses
//
// Styles are injected at runtime by each module, so dist/style.css is an empty
// placeholder kept only so a side-effect `import '@three-ws/tour/style.css'`
// resolves for build tooling that expects it.

import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
	entryPoints: [resolve(here, 'src/index.js')],
	outdir: outDir,
	bundle: true,
	format: 'esm',
	splitting: true,
	platform: 'browser',
	target: 'es2020',
	// Peer dependencies — never inline them.
	external: ['three', 'three/addons/*', '@three-ws/walk'],
	outExtension: { '.js': '.mjs' },
	entryNames: '[name]',
	chunkNames: 'chunk-[name]-[hash]',
	legalComments: 'none',
	metafile: true,
	logLevel: 'info',
});

// Standalone IIFE for a plain CDN <script> — three and @three-ws/walk inlined
// (walk resolved from the monorepo source so fixes ship together), exposed as
// window.ThreeWsTour, with data-attribute auto-init (see src/global.js).
await build({
	entryPoints: [resolve(here, 'src/global.js')],
	bundle: true,
	format: 'iife',
	globalName: 'ThreeWsTour',
	minify: true,
	sourcemap: true,
	platform: 'browser',
	target: 'es2020',
	alias: { '@three-ws/walk': resolve(here, '../walk-sdk/src/index.js') },
	// import.meta doesn't exist in an IIFE — pin the dev flag off explicitly.
	define: { 'import.meta.env.DEV': 'false' },
	outfile: resolve(outDir, 'tour.global.js'),
	legalComments: 'none',
	logLevel: 'info',
	footer: { js: 'if(typeof window!=="undefined"){window.createFeatureTour=ThreeWsTour.createFeatureTour;}' },
});

writeFileSync(
	resolve(outDir, 'style.css'),
	'/* @three-ws/tour — styles are injected at runtime by the tour director and its UI modules. */\n',
);

const out = Object.keys(result.metafile.outputs)
	.map((p) => p.replace(/^.*tour-sdk\//, ''))
	.sort();
console.log('[tour-sdk] built:\n  ' + out.join('\n  ') + '\n  dist/tour.global.js');

// Guards the esbuild-trap guard itself (scripts/guard-esbuild-bundles.mjs).
//
// `npx vercel build` / scripts/bundle-api.mjs esbuild every api route and write
// the bundle back over the source (--outdir=api --allow-overwrite). Committing
// one of those bundles destroys the hand-written route and balloons the repo
// (commits c94190b3, dabd5884 — both reverted). The guard refuses to commit a
// bundled api/*.js; these tests pin its detection so it can neither miss a real
// bundle nor false-positive on hand-written source.

import { describe, it, expect } from 'vitest';
import { detectBundleMarker, findBundledFiles } from '../scripts/guard-esbuild-bundles.mjs';

describe('detectBundleMarker', () => {
	it('flags esbuild __defProp helper on line 1', () => {
		expect(detectBundleMarker('var __defProp = Object.defineProperty;\n// ...\n')).toBe('__defProp');
	});

	it('flags __defProp after a leading "use strict" preamble (line 2)', () => {
		expect(detectBundleMarker('"use strict";\nvar __defProp = Object.defineProperty;\n')).toBe(
			'__defProp',
		);
	});

	it('flags the bundle-api createRequire banner', () => {
		const banner = "var require = (await import('node:module')).createRequire(import.meta.url);\n";
		expect(detectBundleMarker(banner)).toBe('createRequire');
	});

	it('flags esbuild __commonJS / __toESM interop helpers', () => {
		expect(detectBundleMarker('var __commonJS = (cb, mod) => ...\n')).toBe('__commonJS');
		expect(detectBundleMarker('var __toESM = (mod) => ...\n')).toBe('__toESM');
	});

	it('passes a hand-written route opening with a JSDoc block', () => {
		expect(detectBundleMarker('/**\n * GET /api/foo\n */\nexport default function handler() {}\n')).toBeNull();
	});

	it('passes a hand-written route opening with imports', () => {
		const src = "import { authenticateBearer } from './_lib/auth.js';\nexport default async function handler(req, res) {}\n";
		expect(detectBundleMarker(src)).toBeNull();
	});

	it('does NOT trip on a marker that appears only deep in the file (past the head window)', () => {
		const src =
			'// real source\n'.repeat(10) + 'const x = createRequire(import.meta.url);\n';
		expect(detectBundleMarker(src)).toBeNull();
	});
});

describe('findBundledFiles', () => {
	it('returns only the bundled entries, with their marker', () => {
		const entries = [
			{ path: 'api/good.js', content: '/**\n * ok\n */\n' },
			{ path: 'api/bad.js', content: 'var __defProp = Object.defineProperty;\n' },
			{ path: 'api/skipped.js', content: null },
		];
		expect(findBundledFiles(entries)).toEqual([{ path: 'api/bad.js', marker: '__defProp' }]);
	});

	it('returns [] when every entry is hand-written source', () => {
		const entries = [
			{ path: 'api/a.js', content: 'export default function () {}\n' },
			{ path: 'api/b.js', content: '// comment\nconst x = 1;\n' },
		];
		expect(findBundledFiles(entries)).toEqual([]);
	});
});

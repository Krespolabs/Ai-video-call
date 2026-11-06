import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

// Guards against a real production outage: `functions.<route>.includeFiles` in
// vercel.json is a SINGLE node-glob pattern, not a comma-separated list. A bare
// comma outside `{}` is a literal character, so a value like
//   "src/solana/vanity/wasm/**,examples/skills/**"
// matches a path that literally contains a comma — i.e. nothing — and the
// function ships without those files. That silently broke GET /api/x402/vanity
// (the grinder WASM was never bundled: "wasm_not_bundled" at runtime).
//
// The fix is brace expansion: "{a/**,b/**}". These tests assert every
// includeFiles glob is brace-wrapped AND actually resolves to files on disk.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

const includeEntries = Object.entries(vercel.functions || {})
	.filter(([, cfg]) => typeof cfg.includeFiles === 'string')
	.map(([route, cfg]) => ({ route, glob: cfg.includeFiles }));

describe('vercel.json includeFiles globs', () => {
	it('declares includeFiles for at least the data-dependent routes', () => {
		expect(includeEntries.length).toBeGreaterThan(0);
	});

	it.each(includeEntries)('$route: not a raw comma-separated list', ({ glob }) => {
		// A top-level comma (outside braces) means the author intended a list but
		// node-glob will treat it as one literal pattern. Reject it.
		const withoutBraces = glob.replace(/\{[^}]*\}/g, '');
		expect(withoutBraces, `"${glob}" has a comma outside {} braces`).not.toContain(',');
	});

	it.each(includeEntries)('$route: every brace member matches real files', ({ glob }) => {
		// Expand the brace group ourselves so a single dead member can't hide
		// behind sibling members that do match.
		const inner = glob.replace(/^\{/, '').replace(/\}$/, '');
		for (const member of inner.split(',')) {
			const hits = globSync(member, { cwd: repoRoot, dot: false });
			expect(hits.length, `pattern "${member}" matched no files`).toBeGreaterThan(0);
		}
	});
});

describe('vanity grinder WASM ships to its function', () => {
	const vanityGlob = vercel.functions?.['api/x402/vanity.js']?.includeFiles;

	it('api/x402/vanity.js has an includeFiles glob', () => {
		expect(vanityGlob).toBeTruthy();
	});

	it('the glob actually matches the grinder .wasm binary', () => {
		const hits = globSync(vanityGlob, { cwd: repoRoot, dot: false });
		expect(
			hits.some((f) => f.endsWith('src/solana/vanity/wasm/vanity_grinder_bg.wasm')),
			`vanity includeFiles "${vanityGlob}" does not match the grinder WASM`,
		).toBe(true);
	});
});

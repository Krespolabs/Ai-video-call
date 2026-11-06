import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const ibmCssPath = resolve(repoRoot, 'public/ibm.css');

// Guards public/ibm.css: ensures the shared IBM Carbon design system stylesheet
// defines the canonical tokens, aliases, and primitives all IBM pages depended on.
// (The pages/ibm/ pages themselves were removed in commit 7af4f0b3; only the
// shared stylesheet and its src/ibm-*.js logic modules remain.)

const ibmCss = existsSync(ibmCssPath) ? readFileSync(ibmCssPath, 'utf8') : '';

// Names every legacy page relies on; deleting any of these aliases would break
// pages that still say var(--up) / var(--ibm) etc.
const REQUIRED_ALIASES = [
	'bg', 'panel', 'panel-solid', 'panel-2', 'panel2', 'border', 'border-hi',
	'text', 'ink', 'muted', 'faint', 'ibm', 'ibm-light', 'ibm-dim',
	'up', 'down', 'green', 'allow', 'block', 'warn', 'review', 'amber',
	'radius', 'shadow', 'mono', 'font',
];

const CANONICAL_TOKENS = [
	'ibm-bg', 'ibm-panel', 'ibm-border', 'ibm-text', 'ibm-muted',
	'ibm-blue', 'ibm-blue-light', 'ibm-green', 'ibm-red', 'ibm-amber',
];

function definedTokens(css) {
	const out = new Set();
	for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) out.add(m[1].slice(2));
	return out;
}


describe('IBM design system — public/ibm.css', () => {
	it('the shared stylesheet exists', () => {
		expect(existsSync(ibmCssPath), 'public/ibm.css must exist').toBe(true);
	});

	it('defines the canonical IBM Carbon tokens', () => {
		const defs = definedTokens(ibmCss);
		for (const t of CANONICAL_TOKENS) {
			expect(defs.has(t), `ibm.css must define --${t}`).toBe(true);
		}
	});

	it('keeps the back-compat aliases the pages depend on', () => {
		const defs = definedTokens(ibmCss);
		for (const a of REQUIRED_ALIASES) {
			expect(defs.has(a), `ibm.css must alias --${a} (a page still uses it)`).toBe(true);
		}
	});

	it('uses the real IBM Carbon palette', () => {
		expect(ibmCss).toMatch(/#0f62fe/i); // Blue 60
		expect(ibmCss).toMatch(/#42be65/i); // Green 50
		expect(ibmCss).toMatch(/#fa4d56/i); // Red 50
		expect(ibmCss).toMatch(/#f1c21b/i); // Yellow 30
	});

	it('ships the shared state + a11y primitives', () => {
		// the fix for "blank panel / spinner-forever on 503" lives here
		expect(ibmCss).toContain('.ibm-state');
		expect(ibmCss).toContain('.ibm-skeleton');
		expect(ibmCss).toContain('.ibm-spinner');
		expect(ibmCss).toContain(':focus-visible');
		expect(ibmCss).toContain('prefers-reduced-motion');
	});
});


// Pins the review-baseline half of the doc freshness system.
//
// Drift used to be measured from one clock, the doc's last commit, so reading a
// page and finding it correct could not be recorded: the only ways to clear it
// were a cosmetic edit or a permanent false positive. data/docs-freshness-reviews.json
// is the second clock, and it only works while every stamp in it is real. A stamp
// for a deleted doc, or one naming a commit this repo does not have, silently
// suppresses drift for that page, which is the exact failure the dashboard exists
// to prevent.
//
// The full measurement lives in scripts/doc-freshness.mjs and takes ~10s over all
// of git history, so it runs in `npm run gate` rather than here. This file guards
// the store's integrity and the wiring, which is cheap and catches the cases a
// `git add -A` sweep or a hand edit would introduce.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = JSON.parse(readFileSync(path.join(ROOT, 'data/docs-freshness-reviews.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const reviews = Object.entries(store.reviews || {});

describe('the review store stays honest', () => {
	it('every stamped doc still exists', () => {
		const missing = reviews.filter(([docPath]) => !existsSync(path.join(ROOT, docPath)));
		expect(
			missing.map(([p]) => p),
			'drop dead stamps with `npm run docs:review -- --prune`',
		).toEqual([]);
	});

	it('every stamp names a markdown doc', () => {
		expect(reviews.filter(([p]) => !p.endsWith('.md')).map(([p]) => p)).toEqual([]);
	});

	it('every stamp names a commit this repository has', () => {
		const unknown = reviews.filter(([, entry]) => {
			try {
				execFileSync('git', ['cat-file', '-e', `${entry.commit}^{commit}`], {
					cwd: ROOT,
					stdio: 'ignore',
				});
				return false;
			} catch {
				return true;
			}
		});
		expect(
			unknown.map(([p, e]) => `${p} -> ${e.commit}`),
			'a stamp at an unknown commit claims a baseline nobody can check',
		).toEqual([]);
	});

	it('every stamp declares a kind the analyzer understands', () => {
		const bad = reviews.filter(([, e]) => e.kind !== 'verified' && e.kind !== 'snapshot');
		expect(bad.map(([p, e]) => `${p} -> ${e.kind}`)).toEqual([]);
	});
});

describe('the freshness system stays wired', () => {
	it('docs:review points at the stamping script', () => {
		expect(pkg.scripts['docs:review']).toContain('scripts/docs-review.mjs');
		expect(existsSync(path.join(ROOT, 'scripts/docs-review.mjs'))).toBe(true);
	});

	it('build:gcp regenerates the report before the frontend build copies public/', () => {
		const chain = pkg.scripts['build:gcp'] ?? '';
		expect(chain).toContain('npm run docs:freshness');
		// `vite build` runs with emptyOutDir and copies public/ into dist/, so a
		// report written after it would never reach the deployed site.
		expect(chain.indexOf('npm run docs:freshness')).toBeLessThan(
			chain.indexOf('npm run build &&'),
		);
	});
});

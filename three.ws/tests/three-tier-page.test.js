// Wiring tests for the canonical $THREE tier surface (/three).
//
// The page itself (src/three-tier-page.js) is a browser rendering surface whose
// data contract is already covered end-to-end by the API + library suites
// (three-tier.test.js, three-access.test.js, api/three-access.test.js,
// three-tier-public.test.js). What is NOT covered elsewhere — and what would
// silently break the whole "every locked state routes here" guarantee — is the
// ROUTING: that /three serves the tier page (not the old redirect to the coin
// page), that it's registered for the build + sitemap, and that the page shell
// loads the controller. These are filesystem/config assertions, so they run
// without a browser.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

describe('/three tier surface — routing & registration', () => {
	let vercel, pages;
	beforeAll(() => {
		vercel = JSON.parse(read('vercel.json'));
		pages = JSON.parse(read('data/pages.json'));
	});

	it('serves the tier page at /three (no longer a redirect to the coin page)', () => {
		const route = vercel.routes.find((r) => r.src === '/three/?');
		expect(route, 'a /three route must exist').toBeTruthy();
		// The whole point: /three is now the upgrade surface, served as a page.
		expect(route.dest).toBe('/three.html');
		expect(route.status).toBeUndefined();
		expect(route.headers?.Location).toBeUndefined();
	});

	it('keeps the coin price/chart page distinct at /three-token', () => {
		const route = vercel.routes.find((r) => r.src === '/three-token/?');
		expect(route?.dest).toBe('/three-token.html');
	});

	it('registers /three in the page index with non-empty, $THREE-only copy', () => {
		// pages.json nests page lists; flatten any array of objects with a `path`.
		const all = [];
		const walk = (node) => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (node && typeof node === 'object') {
				if (typeof node.path === 'string') all.push(node);
				Object.values(node).forEach(walk);
			}
		};
		walk(pages);
		const entry = all.find((p) => p.path === '/three');
		expect(entry, '/three must be registered in data/pages.json').toBeTruthy();
		expect(entry.title.length).toBeGreaterThan(0);
		expect(entry.description.length).toBeGreaterThan(0);
		// $THREE is the only coin — the copy must not name another token.
		const blob = `${entry.title} ${entry.description}`.toLowerCase();
		expect(blob).toContain('$three');
	});

	it('the page shell loads the controller, the shared nav, and the footer', () => {
		const html = read('pages/three.html');
		expect(html).toContain('/src/three-tier-page.js');
		expect(html).toContain('/nav.js');
		expect(html).toContain('/footer.js');
		expect(html).toContain('id="tier-root"');
		// canonical/OG point at the tier surface, not the coin page.
		expect(html).toContain('https://three.ws/three');
	});

	it('is wired into the Vite build input and dev-server route map', () => {
		const cfg = read('vite.config.js');
		expect(cfg).toContain("three: resolve(__dirname, 'pages/three.html')");
		expect(cfg).toContain("'/three': resolve(root, 'pages/three.html')");
	});
});

describe('locked-state CTAs route to the /three upgrade surface', () => {
	it('the nav tier chip + in-place lock default both target /three', () => {
		const access = read('src/three-access.js');
		const lock = read('src/three-lock.js');
		// The canonical upgrade destination constant in each client module.
		expect(access).toMatch(/const ECONOMY_URL = '\/three';/);
		expect(lock).toMatch(/const ECONOMY_URL = '\/three';/);
		// The coin page stays reachable as the secondary "price & chart" link.
		expect(access).toMatch(/const PRICE_URL = '\/three-token';/);
	});

	it('the Forge High-quality lock routes to /three', () => {
		const forge = read('src/forge.js');
		expect(forge).toContain("getThreeUrl: '/three'");
		expect(forge).not.toContain("getThreeUrl: '/three-token'");
	});
});

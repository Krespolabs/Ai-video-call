import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const html = read('pages/atomic.html');
const js = read('src/atomic.js');
const css = read('src/atomic.css');
const routes = JSON.parse(read('vercel.json')).routes;
const pages = JSON.parse(read('data/pages.json'));
const vite = read('vite.config.js');
const nav = read('public/nav-data.js');

function declaredPaths(node, out = new Set()) {
	if (Array.isArray(node)) node.forEach((value) => declaredPaths(value, out));
	else if (node && typeof node === 'object') {
		if (typeof node.path === 'string') out.add(node.path);
		Object.values(node).forEach((value) => declaredPaths(value, out));
	}
	return out;
}

describe('Atomic page wiring', () => {
	it('is reachable in production, development, navigation, and discovery', () => {
		expect(routes.find((route) => route.src === '/atomic/?')?.dest).toBe('/atomic.html');
		expect(vite).toContain("atomic: resolve(__dirname, 'pages/atomic.html')");
		expect(vite).toContain("'/atomic': resolve(root, 'pages/atomic.html')");
		expect(nav).toContain("href: '/atomic'");
		const paths = declaredPaths(pages);
		expect(paths.has('/atomic')).toBe(true);
		expect(paths.has('/docs/atomic')).toBe(true);
		expect(existsSync(resolve(ROOT, 'api/solana/atomic.js'))).toBe(true);
	});

	it('mounts every static element used by the client', () => {
		const ids = [...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((match) => match[1]);
		expect(ids.length).toBeGreaterThan(20);
		for (const id of new Set(ids)) expect(html, `missing #${id}`).toContain(`id="${id}"`);
	});

	it('is read-only and exposes designed loading, error, empty, and report states', () => {
		expect(js).toContain("fetch('/api/solana/atomic'");
		expect(js).not.toMatch(/\.sendRawTransaction|\.signTransaction|\/api\/[^'"`]*broadcast/);
		for (const state of ['loading', 'error', 'empty', 'report']) expect(html).toContain(`id="at-${state}"`);
		expect(css).toContain('@media (prefers-reduced-motion: reduce)');
	});
});

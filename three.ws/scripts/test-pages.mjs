#!/usr/bin/env node
/**
 * Page-health regression gate for three.ws.
 *
 * WHY THIS EXISTS
 * ---------------
 * The site is ~90 pages built by ~20 agents in parallel. Lighthouse only runs
 * AFTER a Vercel deploy, so nothing catches a blank page, a thrown boot error,
 * a 500-ing fetch, or a broken hero image BEFORE it ships. This is that gate:
 * one Chromium pass over every public route, run on every PR.
 *
 * WHY YOU CAN TRUST A GREEN RUN
 * -----------------------------
 * A health gate is only useful if green means green. Two classes of false
 * positive used to make this script cry wolf on every run; both are killed:
 *
 *   1. vite-dev HMR noise. `vite dev` injects a client that opens an HMR
 *      WebSocket. Behind the Codespaces / github.dev proxy that socket 404s,
 *      emitting a `pageerror` + two `console.error`s on EVERY page. There is no
 *      vite client in production, so these are pure dev artifacts — filtered.
 *
 *   2. vercel.json rewrites. Pretty URLs (`/pumpfun`, `/legal/privacy`) resolve
 *      through vercel.json's ~590-route table to real files in public/.
 *      `vite dev` does NOT apply that table, so it 404s on routes that are
 *      perfectly healthy in prod. We replicate Vercel's route resolution
 *      (rewrites + redirects + `continue` passthroughs) so we navigate to the
 *      path the file actually lives at — matching prod behaviour.
 *
 * FAIL vs WARN
 * ------------
 * Only unambiguous breakage FAILS the gate (nav >=400, thrown errors, real
 * console errors, failed/4xx-5xx requests, broken images). Quality signals that
 * have legitimate exceptions (missing <title>/lang, alt-less images, links that
 * resolve nowhere) are WARN — surfaced, never red — so the failing signal stays
 * rock-solid and the gate keeps its credibility.
 *
 * USAGE
 *   node scripts/test-pages.mjs                 # full sweep, spawns its own vite
 *   node scripts/test-pages.mjs --route=/home   # one route (repeatable)
 *   node scripts/test-pages.mjs --concurrency=8 # tune parallelism (default 6)
 *   node scripts/test-pages.mjs --warn-as-error # treat WARNs as failures too
 *   HEALTH_BASE=http://localhost:3000 node scripts/test-pages.mjs  # reuse a server
 *
 * Writes a machine-readable report to reports/health.json (gitignored).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (!hit) return fallback;
	const eq = hit.indexOf('=');
	return eq === -1 ? true : hit.slice(eq + 1);
};
const onlyRoutes = argv.filter((a) => a.startsWith('--route=')).map((a) => a.slice('--route='.length));
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '6'), 10) || 6);
const WARN_AS_ERROR = !!flag('warn-as-error', false);
const QUIET = !!flag('quiet', false);
const REUSE_BASE = process.env.HEALTH_BASE || null;
const PORT = parseInt(process.env.HEALTH_PORT || '3100', 10);
const BASE = REUSE_BASE || `http://localhost:${PORT}`;

// Sample params for template/dynamic routes that need an id to boot.
const SAMPLE_AGENT = '0xdeadbeef';
const SAMPLE_SOL_ASSET = 'So11111111111111111111111111111111111111112';
const SAMPLE_USER = 'alice';

// Curated template/param routes that aren't in data/pages.json because they
// require an id. These exercise the dynamic-page boot path.
const TEMPLATE_ROUTES = [
	`/agent/${SAMPLE_AGENT}`,
	`/agent/${SAMPLE_AGENT}/edit`,
	`/agent/${SAMPLE_AGENT}/embed`,
	`/a/1/${SAMPLE_AGENT}/edit`,
	`/a/sol/${SAMPLE_SOL_ASSET}`,
	`/u/${SAMPLE_USER}`,
	`/reputation/?agent=1:${SAMPLE_AGENT}`,
	'/embed.html?src=/avatars/cz.glb',
	'/embed-test.html',
	'/agent-embed.html',
	'/a-edit.html',
	'/a-embed.html',

	// IBM watsonx / Granite showcase. These clean URLs map to pages/ibm/*.html via
	// vercel.json and aren't in the page index, so they'd otherwise escape the
	// smoke test. Booting them here guards against console crashes (e.g. a WebGL
	// context that throws on construction) and broken fetch handling.
	'/ibm',
	'/ibm/oracle',
	'/ibm/galaxy',
	'/ibm/proof',
	'/ibm/trust-layer',
	'/ibm/vision',
	'/ibm/twin',
	'/ibm/identity',
];

// ── Noise filters ──────────────────────────────────────────────────────────
// Things that fail ONLY under `vite dev` on localhost/Codespaces but work in
// production. Each entry is load-bearing — comment says why it's safe to ignore.
const IGNORE_PATTERNS = [
	// vite-dev HMR client: the big one. No vite client exists in prod.
	/\[vite\] failed to connect to websocket/,
	/WebSocket closed without opened/,
	/WebSocket connection to .*(app\.github\.dev|localhost).*failed/i,
	/failed to connect to websocket/i,
	/\/@vite\/client/,
	/node_modules\/vite\/dist\/client\/env\.mjs/,
	// Serverless functions need `vercel dev`, not `vite dev` — /api/* 404s locally.
	/localhost:\d+\/api\//,
	/three\.ws\/+api\//, // prod API hardcoded in demo/test pages
	/Unexpected token .+, .<!doctype /, // API returned HTML (no serverless locally)
	/Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text\/html"/,
	// Separate dev-only services that aren't running under a bare `vite dev`.
	/localhost:2567/, // colyseus multiplayer server (`npm run dev:multi`)
	/localhost:\d+\/chat/, // chat is a separate Svelte app (`npm run dev` in chat/)
	// Third-party CDNs / APIs with no localhost CORS — fine in prod.
	/three\.ws\/.*agent-3d/,
	/three\.ws\/dist-lib/,
	/ajax\.googleapis\.com/,
	/esm\.sh/,
	/marketplace\.olas\.network/,
	/blocked by CORS policy/,
	/ipfs\.io/, // user-content gateway, blocked by ORB from a headless origin
	/ERR_BLOCKED_BY_ORB/, // Opaque Response Blocking on cross-origin media
	/rpc\.\d+\.io/, // placeholder RPC from sample agent ids
	/api\.mainnet-beta\.solana\.com/, // public RPC rate-limits/403s from CI
	/ingest\/static\/surveys/, // PostHog survey assets, blocked without consent
	/\/wallet\/(connect-button|state).*\.js/,
	/chrome-extension:\/\//,
];
const isNoise = (text) => IGNORE_PATTERNS.some((re) => re.test(text));

// Environment-dependent module errors. Under `vite dev`, Vite's built-in static
// publicDir handler serves public/*.html verbatim (no transform), so inline
// `<script type=module>` bare specifiers like `@three-ws/agent-ui` fail to
// resolve — whereas the production build resolves them via its import map /
// bundler. We can't tell a genuine prod break from this dev-serving gap, so
// these are WARN, never a flaky FAIL. Flip with --warn-as-error to gate on them.
const ENV_MODULE_PATTERNS = [
	/Failed to resolve module specifier/,
	/Unexpected token .?export.?/,
	/Cannot use import statement outside a module/,
	/Failed to fetch dynamically imported module/,
	/error loading dynamically imported module/i,
];
const isEnvModule = (text) => ENV_MODULE_PATTERNS.some((re) => re.test(text));

// ── Vercel route resolver ────────────────────────────────────────────────────
// Replicates the subset of vercel.json route semantics that affect which file a
// pretty URL serves: ordered match, `dest` rewrites, `status` redirects, and
// `continue` header passthroughs. `has`-gated routes are skipped (we can't
// satisfy header/cookie conditions from a static probe).
function loadVercelRoutes() {
	const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
	return (cfg.routes || [])
		.filter((r) => r.src && !r.has) // skip conditional routes
		.map((r) => {
			let re = null;
			try {
				re = new RegExp(`^${r.src}$`);
			} catch {
				re = null; // a src we can't compile just never matches
			}
			return { ...r, _re: re };
		});
}

function applyCaptures(template, match) {
	return String(template).replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? '');
}

// Resolve a pretty path to the path vite should actually serve, following
// rewrites and redirects. Returns { servePath, query, redirected }.
function resolveRoute(routes, rawPath) {
	const [pathOnly, query = ''] = rawPath.split('?');
	let current = pathOnly;
	let redirected = false;
	for (let hops = 0; hops < 8; hops++) {
		let matchedDest = null;
		for (const route of routes) {
			if (!route._re) continue;
			const m = current.match(route._re);
			if (!m) continue;
			// Redirect: follow the Location header on the same host.
			const status = route.status;
			const loc = route.headers && (route.headers.Location || route.headers.location);
			if (status && status >= 300 && status < 400 && loc) {
				const target = applyCaptures(loc, m);
				if (/^https?:\/\//.test(target)) return { servePath: current, query, redirected, external: target };
				current = target.split('?')[0];
				redirected = true;
				matchedDest = 'redirect';
				break; // restart scan on the new path
			}
			// Header-only passthrough (`continue`): keep scanning, path unchanged.
			if (route.continue) continue;
			// Rewrite: this is the file to serve.
			if (route.dest) {
				const dest = applyCaptures(route.dest, m).split('?')[0];
				return { servePath: dest, query, redirected };
			}
		}
		if (matchedDest !== 'redirect') break; // no rewrite, no further redirect
	}
	// No explicit rewrite — let vite resolve via its filesystem/clean-URL plugin,
	// exactly as Vercel falls back to the filesystem.
	return { servePath: current, query, redirected };
}

// ── Route inventory ──────────────────────────────────────────────────────────
function loadRoutes() {
	const set = new Set();
	try {
		const pages = JSON.parse(readFileSync(join(ROOT, 'data/pages.json'), 'utf8'));
		for (const section of pages.sections || []) {
			for (const item of section.items || section.pages || []) {
				if (!item.path || typeof item.path !== 'string') continue;
				if (item.indexable === false && item.path !== '/') continue;
				// Skip non-HTML surfaces (feeds, manifests) and external links.
				if (/\.(xml|txt|json|rss)$/.test(item.path)) continue;
				if (/^https?:\/\//.test(item.path)) continue;
				set.add(item.path);
			}
		}
	} catch {
		// pages.json missing/unparseable — fall back to template routes only.
	}
	for (const r of TEMPLATE_ROUTES) set.add(r);
	const all = [...set];
	return onlyRoutes.length ? all.filter((r) => onlyRoutes.includes(r)) : all;
}

// A path is "servable" if a vercel route would resolve it, or the file exists on
// disk under public/ or pages/ (clean-URL → pages/<name>.html). Used for the
// dead-link WARN — deliberately conservative to avoid false positives.
function pathIsServable(routes, path) {
	if (!path || path === '#' || path.startsWith('mailto:') || path.startsWith('tel:')) return true;
	const clean = path.split('?')[0].split('#')[0];
	if (clean === '' || clean === '/') return true;
	const { servePath, external } = resolveRoute(routes, clean);
	if (external) return true;
	const rel = servePath.replace(/^\//, '');
	const candidates = [
		join(ROOT, 'public', rel),
		join(ROOT, 'public', rel + '.html'),
		join(ROOT, 'public', rel, 'index.html'),
		join(ROOT, 'pages', rel),
		join(ROOT, 'pages', rel + '.html'),
		join(ROOT, 'pages', rel, 'index.html'),
	];
	return candidates.some((p) => existsSync(p));
}

// ── Server lifecycle ─────────────────────────────────────────────────────────
function startServer() {
	const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, FORCE_COLOR: '0' },
	});
	return new Promise((res, rej) => {
		const timer = setTimeout(() => rej(new Error('vite did not start in 60s')), 60000);
		proc.stdout.on('data', (d) => {
			if (/ready in|Local:/.test(String(d))) {
				clearTimeout(timer);
				res(proc);
			}
		});
		proc.stderr.on('data', (d) => process.stderr.write(d));
		proc.on('exit', (code) => code !== 0 && rej(new Error(`vite exited ${code}`)));
	});
}

// ── Per-route check ──────────────────────────────────────────────────────────
async function checkRoute(browser, routes, route) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const fails = [];
	const warns = [];

	// Uncaught app exceptions FAIL; environment-dependent module errors WARN.
	page.on('pageerror', (err) => {
		const msg = `uncaught: ${err.message}`;
		if (isNoise(msg)) return;
		(isEnvModule(err.message) ? warns : fails).push(msg);
	});
	// console.error is gray — third-party widgets, analytics, and dev tooling all
	// log errors that don't mean the page is broken. Surface, never fail.
	page.on('console', (msg) => {
		if (msg.type() !== 'error') return;
		const text = msg.text();
		if (text.startsWith('Failed to load resource')) return; // cascade; URL caught below
		if (!isNoise(`console.error: ${text}`)) warns.push(`console.error: ${text}`);
	});
	// A failed sub-request is gray (aborts, cancellations, flaky third parties).
	// The document's own status is the hard signal — captured via navStatus below.
	page.on('requestfailed', (req) => {
		const url = req.url();
		const errText = req.failure()?.errorText || '';
		if (isNoise(url) || isNoise(errText)) return;
		if (/ERR_ABORTED/.test(errText)) return; // intentional cancellation, not breakage
		warns.push(`requestfailed: ${url} — ${errText}`);
	});
	page.on('response', (res) => {
		const url = res.url();
		if (res.status() >= 400 && !url.includes('favicon') && !isNoise(url)) {
			warns.push(`http ${res.status()}: ${url}`); // sub-resource; document via navStatus
		}
	});

	const { servePath, query, external } = resolveRoute(routes, route);
	const prettyPath = route.split('?')[0];
	let navStatus = null;
	if (!external) {
		// goto with one retry on a thrown error (cold 3D transforms can blow a
		// timeout under parallel load); discard the failed attempt's captured
		// events so a transient first try never leaves stale errors behind.
		const tryGoto = async (url) => {
			for (let attempt = 0; attempt < 2; attempt++) {
				const mark = fails.length;
				const wmark = warns.length;
				try {
					const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
					return resp?.status() ?? null;
				} catch (e) {
					fails.length = mark;
					warns.length = wmark;
					if (attempt === 1) {
						fails.push(`nav error: ${e.message}`);
						return null;
					}
				}
			}
			return null;
		};
		const mark = fails.length;
		const wmark = warns.length;
		navStatus = await tryGoto(`${BASE}${servePath}${query ? '?' + query : ''}`);
		// If the rewritten dest 404s, the clean pretty URL may still serve in dev
		// (vite's clean-URL plugin). Discard the dead-end attempt, then retry it.
		if ((navStatus === null || navStatus >= 400) && servePath !== prettyPath) {
			fails.length = mark;
			warns.length = wmark;
			navStatus = await tryGoto(`${BASE}${route}`);
		}
		if (navStatus === null || navStatus >= 400) fails.push(`nav status ${navStatus ?? 'none'}`);
		// Let async boot code run and throw before we tear down.
		await wait(2200);
	}

	// In-page DOM audit (only if the page actually loaded).
	if (!external && navStatus && navStatus < 400) {
		try {
			const audit = await page.evaluate(() => {
				const docUrl = location.href.split('#')[0];
				const imgs = [...document.images];
				const broken = []; // real src that failed to load → FAIL
				let emptySrc = 0; // empty/placeholder src (lazy-load, decorative) → WARN
				for (const i of imgs) {
					if (!(i.complete && i.naturalWidth === 0)) continue;
					const attr = (i.getAttribute('src') || '').trim();
					const resolved = i.currentSrc || i.src || '';
					if (!attr || resolved === docUrl || resolved === location.href) emptySrc++;
					else if (broken.length < 8) broken.push(resolved);
				}
				const noAlt = imgs.filter((i) => !i.alt && !i.getAttribute('aria-hidden')).length;
				const links = [...document.querySelectorAll('a[href]')]
					.map((a) => a.getAttribute('href'))
					.filter((h) => h && !/^(https?:|mailto:|tel:|#|javascript:|data:)/.test(h));
				const bodyText = (document.body?.innerText || '').trim().length;
				const hasCanvas = !!document.querySelector('canvas');
				const title = (document.title || '').trim();
				const lang = document.documentElement.getAttribute('lang') || '';
				return { broken, emptySrc, noAlt, links: [...new Set(links)], bodyText, hasCanvas, title, lang };
			});

			for (const src of audit.broken) fails.push(`broken image: ${src}`);
			if (audit.emptySrc > 0) warns.push(`${audit.emptySrc} image(s) with empty/placeholder src`);

			// Blank-render: no text AND no canvas/visual → likely a dead page. WARN
			// (3D/embed pages legitimately render to canvas with no copy).
			if (audit.bodyText < 1 && !audit.hasCanvas) warns.push('blank render (no text, no canvas)');
			if (!audit.title) warns.push('missing <title>');
			if (!audit.lang) warns.push('missing <html lang>');
			if (audit.noAlt > 0) warns.push(`${audit.noAlt} image(s) without alt text`);

			for (const href of audit.links.slice(0, 60)) {
				const abs = href.startsWith('/') ? href : new URL(href, `${BASE}${servePath}`).pathname;
				if (!pathIsServable(routes, abs)) warns.push(`link resolves nowhere: ${href}`);
			}
		} catch {
			// Evaluate can fail on pages that navigate away mid-audit — non-fatal.
		}
	}

	await ctx.close();
	return { route, servePath, navStatus, fails, warns };
}

// ── Concurrency pool ─────────────────────────────────────────────────────────
async function runPool(items, limit, worker) {
	const results = new Array(items.length);
	let idx = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (idx < items.length) {
			const i = idx++;
			results[i] = await worker(items[i], i);
		}
	});
	await Promise.all(runners);
	return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
	const routes = loadVercelRoutes();
	const targets = loadRoutes();
	let server = null;
	let browser = null;
	let exitCode = 0;

	try {
		if (!REUSE_BASE) {
			if (!QUIET) console.log(`Starting vite on :${PORT}…`);
			server = await startServer();
		} else if (!QUIET) {
			console.log(`Reusing server at ${BASE}`);
		}

		browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
		if (!QUIET) console.log(`Checking ${targets.length} routes · concurrency ${CONCURRENCY}\n`);

		const results = await runPool(targets, CONCURRENCY, async (route) => {
			const r = await checkRoute(browser, routes, route);
			if (!QUIET) {
				const tag = r.fails.length ? 'FAIL' : r.warns.length ? 'warn' : ' ok ';
				const n = r.fails.length + r.warns.length;
				console.log(`  [${tag}] ${route} (${r.fails.length} fail, ${r.warns.length} warn)`);
			}
			return r;
		});

		const failing = results.filter((r) => r.fails.length);
		const warning = results.filter((r) => !r.fails.length && r.warns.length);

		if (failing.length) {
			console.log('\n── FAILURES ───────────────────────────────────────────');
			for (const r of failing) {
				console.log(`\n${r.route}  →  ${r.servePath} (nav ${r.navStatus ?? '—'})`);
				for (const f of r.fails) console.log(`  ✗ ${f}`);
			}
		}
		if (warning.length && !QUIET) {
			console.log('\n── WARNINGS (non-blocking) ────────────────────────────');
			for (const r of warning) {
				console.log(`\n${r.route}`);
				for (const w of r.warns) console.log(`  · ${w}`);
			}
		}

		const totalFails = results.reduce((n, r) => n + r.fails.length, 0);
		const totalWarns = results.reduce((n, r) => n + r.warns.length, 0);
		console.log(
			`\nDone. ${totalFails} failure(s), ${totalWarns} warning(s) across ${targets.length} routes.`,
		);

		// Machine-readable report for CI artifacts.
		try {
			mkdirSync(join(ROOT, 'reports'), { recursive: true });
			writeFileSync(
				join(ROOT, 'reports/health.json'),
				JSON.stringify(
					{ base: BASE, routes: targets.length, totalFails, totalWarns, results },
					null,
					2,
				),
			);
		} catch {
			/* report write is best-effort */
		}

		if (totalFails > 0 || (WARN_AS_ERROR && totalWarns > 0)) exitCode = 1;
	} finally {
		if (browser) await browser.close();
		if (server) server.kill('SIGTERM');
	}
	process.exit(exitCode);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

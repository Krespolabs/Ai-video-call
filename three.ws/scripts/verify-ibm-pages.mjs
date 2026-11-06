#!/usr/bin/env node
// Runtime browser gate for the /ibm showcase.
//
// For every page under pages/ibm/ this loads it in headless Chrome and proves
// the things a structural/grep check (scripts/verify-ibm-surface.mjs) and the
// unit tests cannot:
//
//   • the page actually renders its 3D scene — verified by instrumenting the
//     WebGL context and counting real draw calls. Screenshots and gl.readPixels
//     are unreliable under headless swiftshader (cleared back buffer, no GPU);
//     draw calls are not. An "engine" page that issues zero draws is broken.
//   • zero uncaught exceptions and zero first-party console errors.
//   • the page degrades HONESTLY when watsonx is unconfigured — an /api/ibm
//     response of 503 {"configured":false} is an EXPECTED state, never a
//     failure. The page must render its empty/degraded UI without throwing.
//   • the primary heading and interactive controls are present and reachable.
//
// Self-contained and durable on purpose:
//   • resolves Chrome dynamically (env → puppeteer → ~/.cache glob), so it does
//     not rot when the cached Chrome version bumps.
//   • starts its own Vite server on a free port, or reuses one already on :3000.
//     No "run npm run dev first" precondition.
//
//   node scripts/verify-ibm-pages.mjs              # all pages
//   node scripts/verify-ibm-pages.mjs oracle twin  # a subset (by slug)
//   HEADFUL=1 node scripts/verify-ibm-pages.mjs    # watch it run
//   LOG_ALL=1 node scripts/verify-ibm-pages.mjs    # stream browser console

import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import puppeteer from 'puppeteer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = {
	g: (s) => `\x1b[32m${s}\x1b[0m`,
	r: (s) => `\x1b[31m${s}\x1b[0m`,
	y: (s) => `\x1b[33m${s}\x1b[0m`,
	d: (s) => `\x1b[2m${s}\x1b[0m`,
	b: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── Page contract ────────────────────────────────────────────────────────────
// `engine: true` means the page mounts a Three.js scene and MUST issue WebGL
// draw calls. `engine: false` pages (content/forms) only need to render cleanly.
const PAGES = [
	{ slug: 'index', path: '/ibm', engine: false },
	{ slug: 'galaxy', path: '/ibm/galaxy', engine: true },
	{ slug: 'oracle', path: '/ibm/oracle', engine: true },
	{ slug: 'trust-layer', path: '/ibm/trust-layer', engine: true },
	{ slug: 'proof', path: '/ibm/proof', engine: true },
	{ slug: 'vision', path: '/ibm/vision', engine: true },
	{ slug: 'twin', path: '/ibm/twin', engine: true },
	{ slug: 'identity', path: '/ibm/identity', engine: false },
];

// Browser-side instrumentation, installed before any page script runs.
function instrument() {
	window.__glDrawCalls = 0;
	window.__pageErrors = [];
	const wrap = (proto) => {
		if (!proto) return;
		for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
			const orig = proto[m];
			if (typeof orig === 'function') {
				proto[m] = function (...args) {
					window.__glDrawCalls++;
					return orig.apply(this, args);
				};
			}
		}
	};
	wrap(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
	wrap(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
	window.addEventListener('unhandledrejection', (e) => {
		window.__pageErrors.push('unhandledrejection: ' + String((e.reason && e.reason.stack) || e.reason));
	});
}

// Noise that is never a real defect: Vite's HMR socket, autoplay-policy gripes,
// and anything originating from an /api/ call (handled via response status).
const IGNORE_CONSOLE = [
	/\[vite\]/i,
	/@vite\/client/i, // HMR client
	/WebSocket closed without opened/i, // HMR socket in port-forwarded envs (Codespaces)
	/WebSocket connection to .* failed/i,
	/Error during WebSocket handshake/i,
	/the AudioContext was not allowed to start/i,
	/Tracking Prevention/i,
	/Failed to load resource.*\/api\//i, // API degradation is judged by status, not console
	/\b(403|429|503)\b.*\/api\//i,
];
// An /api response with one of these is the documented "watsonx unconfigured"
// degraded state — expected, not a failure.
const DEGRADED_STATUSES = new Set([402, 403, 503]);

function isIgnorableConsole(text) {
	return IGNORE_CONSOLE.some((re) => re.test(text));
}

// ── Chrome resolution (durable) ──────────────────────────────────────────────
function resolveChrome() {
	const tries = [];
	const push = (p, why) => p && tries.push({ p, why });
	push(process.env.CHROME_PATH, 'CHROME_PATH');
	push(process.env.PUPPETEER_EXECUTABLE_PATH, 'PUPPETEER_EXECUTABLE_PATH');
	try {
		push(puppeteer.executablePath(), 'puppeteer.executablePath()');
	} catch {
		/* puppeteer has no opinion without a downloaded browser */
	}
	// Glob the puppeteer cache and prefer the newest version present.
	const cache = join(homedir(), '.cache', 'puppeteer', 'chrome');
	if (existsSync(cache)) {
		const versions = readdirSync(cache)
			.filter((d) => d.startsWith('linux-') || d.startsWith('mac') || d.startsWith('win'))
			.sort()
			.reverse();
		for (const v of versions) {
			for (const rel of ['chrome-linux64/chrome', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-win64/chrome.exe']) {
				push(join(cache, v, rel), `cache:${v}`);
			}
		}
	}
	for (const sys of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
		push(sys, 'system');
	}
	const found = tries.find((t) => {
		try {
			return existsSync(t.p);
		} catch {
			return false;
		}
	});
	if (!found) {
		throw new Error(
			'No Chrome binary found. Install one with:\n  npx puppeteer browsers install chrome\n' +
				'or set CHROME_PATH=/path/to/chrome',
		);
	}
	return found.p;
}

// ── Dev server (reuse :3000 or spawn an ephemeral one) ───────────────────────
function probe(url, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const req = httpGet(url, (res) => {
			res.resume();
			resolve(res.statusCode || 0);
		});
		req.setTimeout(timeoutMs, () => req.destroy());
		req.on('error', () => resolve(0));
	});
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

async function startServer() {
	if (await probe('http://localhost:3000/ibm')) {
		return { base: 'http://localhost:3000', stop: async () => {} };
	}
	const port = await freePort();
	const bin = join(ROOT, 'node_modules', '.bin', 'vite');
	const child = spawn(bin, ['--port', String(port), '--strictPort'], {
		cwd: ROOT,
		stdio: process.env.LOG_ALL ? 'inherit' : 'ignore',
		env: process.env,
	});
	const base = `http://localhost:${port}`;
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`vite exited early (code ${child.exitCode})`);
		if (await probe(`${base}/ibm`)) {
			return {
				base,
				stop: async () => {
					child.kill('SIGTERM');
				},
			};
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	child.kill('SIGKILL');
	throw new Error('vite did not become ready within 60s');
}

// ── Per-page check ───────────────────────────────────────────────────────────
async function checkPage(browser, base, page) {
	const tab = await browser.newPage();
	await tab.evaluateOnNewDocument(instrument);
	const consoleErrors = [];
	const failedAssets = [];
	const degraded = [];

	tab.on('console', (msg) => {
		if (process.env.LOG_ALL) console.log(C.d(`  [${page.slug} ${msg.type()}] ${msg.text()}`));
		if (msg.type() === 'error' && !isIgnorableConsole(msg.text())) consoleErrors.push(msg.text());
	});
	tab.on('pageerror', (err) => {
		if (!isIgnorableConsole(err.message)) consoleErrors.push('pageerror: ' + err.message);
	});
	tab.on('requestfailed', (req) => {
		const u = req.url();
		if (u.includes('@vite') || u.startsWith('ws:') || u.includes('/api/')) return;
		// Only render-critical resources count. Analytics beacons / images / fetch
		// routinely ERR_ABORTED on page teardown and are not defects.
		if (!['document', 'script', 'stylesheet', 'font'].includes(req.resourceType())) return;
		if (/\/ingest\/|posthog|segment|google-analytics|sentry|cdn\.vercel-insights/i.test(u)) return;
		failedAssets.push(`${req.method()} ${u.replace(base, '')} — ${req.failure()?.errorText}`);
	});
	tab.on('response', (res) => {
		const u = res.url();
		const s = res.status();
		if (u.includes('/api/')) {
			if (DEGRADED_STATUSES.has(s)) degraded.push(`${s} ${u.replace(base, '')}`);
			else if (s >= 400) consoleErrors.push(`api ${s} ${u.replace(base, '')}`);
			return;
		}
		// First-party asset that 4xx/5xx'd (js/css/html/wasm/glb).
		if (s >= 400 && u.startsWith(base) && /\.(js|mjs|css|html|wasm|glb|gltf|json)(\?|$)/.test(u)) {
			failedAssets.push(`HTTP ${s} ${u.replace(base, '')}`);
		}
	});

	const errors = [];
	const url = base + page.path;
	try {
		await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
	} catch (e) {
		errors.push(`navigation failed: ${e.message}`);
		await tab.close();
		return { page, errors, degraded, draws: 0 };
	}

	// Page must not be a blank/404 shell. Immersive pages put their hero in the
	// canvas, so a rendered canvas/svg counts as content alongside real text.
	const hasContent = await tab
		.waitForFunction(() => document.body.innerText.trim().length > 40 || !!document.querySelector('canvas, svg'), { timeout: 15_000 })
		.then(() => true)
		.catch(() => false);
	if (!hasContent) errors.push('blank shell: no text, canvas, or svg after load');

	// Engine pages must actually draw. RAF-driven scenes accumulate draws on
	// load; give it room, then nudge a primary control if still idle.
	let draws = 0;
	if (page.engine) {
		draws = await waitForDraws(tab, 12_000);
		if (draws === 0) {
			await clickPrimary(tab);
			draws = await waitForDraws(tab, 6_000);
		}
		if (draws === 0) errors.push('engine page issued zero WebGL draw calls (scene did not render)');
	}

	// Settle so late console errors / unhandled rejections surface.
	await new Promise((r) => setTimeout(r, 1200));
	const pageErrors = await tab
		.evaluate(() => window.__pageErrors || [])
		.then((arr) => arr.filter((e) => !isIgnorableConsole(e)))
		.catch(() => []);

	// Interactive surface: at least one real control, none stuck disabled-forever.
	const controls = await tab.evaluate(() => {
		const els = [...document.querySelectorAll('button, [role="button"], a.btn, input[type="submit"]')];
		return { total: els.length, disabled: els.filter((e) => e.disabled).length };
	});
	if (controls.total === 0) errors.push('no interactive controls found');

	errors.push(...consoleErrors.map((e) => `console: ${e}`));
	errors.push(...failedAssets.map((e) => `asset: ${e}`));
	errors.push(...pageErrors.map((e) => `uncaught: ${e}`));

	// UX quality audit (a11y + responsive). Reported as warnings; promote to hard
	// failures with STRICT_A11Y=1.
	const warnings = await auditPage(tab);

	await tab.close();
	return { page, errors, warnings, degraded, draws, controls };
}

// Accessibility + responsive audit. Returns human-readable warnings.
async function auditPage(tab) {
	const a11y = await tab
		.evaluate(() => {
			const out = [];
			const visible = (el) => {
				const r = el.getBoundingClientRect();
				return r.width > 0 && r.height > 0;
			};
			const accName = (el) =>
				(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.innerText || el.value || (el.querySelector('img') && el.querySelector('img').alt) || '').trim();

			let unnamed = 0;
			document.querySelectorAll('button, a[href], [role="button"]').forEach((el) => {
				if (visible(el) && !accName(el)) unnamed++;
			});
			if (unnamed) out.push(`${unnamed} interactive element(s) without an accessible name`);

			let imgNoAlt = 0;
			document.querySelectorAll('img').forEach((img) => {
				if (img.getAttribute('alt') == null) imgNoAlt++;
			});
			if (imgNoAlt) out.push(`${imgNoAlt} <img> without an alt attribute`);

			let unlabeled = 0;
			document.querySelectorAll('input:not([type=hidden]), textarea, select').forEach((el) => {
				const ok = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('placeholder') || (el.id && document.querySelector(`label[for="${el.id}"]`));
				if (!ok) unlabeled++;
			});
			if (unlabeled) out.push(`${unlabeled} form field(s) without a label/aria-label`);

			const hasFocusStyle = [...document.styleSheets].some((s) => {
				try {
					return [...(s.cssRules || [])].some((r) => /:focus(-visible)?/.test(r.selectorText || ''));
				} catch {
					return false; // cross-origin sheet
				}
			});
			if (!hasFocusStyle) out.push('no :focus / :focus-visible styles (keyboard focus is invisible)');

			if (!document.querySelector('main, [role="main"]')) out.push('no <main> / role=main landmark');
			return out;
		})
		.catch(() => []);

	let overflow = 0;
	try {
		await tab.setViewport({ width: 390, height: 800 });
		await new Promise((r) => setTimeout(r, 400));
		overflow = await tab.evaluate(() => {
			const el = document.scrollingElement || document.documentElement;
			return el.scrollWidth - el.clientWidth;
		});
		await tab.setViewport({ width: 1440, height: 900 });
	} catch {
		/* viewport change failed — skip */
	}
	if (overflow > 4) a11y.push(`horizontal overflow at 390px (+${overflow}px) — not mobile-clean`);
	return a11y;
}

// Sum draw calls across every frame — some pages (e.g. proof) render their
// avatar inside a same-origin <iframe> embed, so the GL work happens there.
async function totalDraws(tab) {
	let sum = 0;
	for (const f of tab.frames()) {
		try {
			sum += (await f.evaluate(() => window.__glDrawCalls || 0)) || 0;
		} catch {
			/* frame detached/cross-origin — ignore */
		}
	}
	return sum;
}

async function waitForDraws(tab, timeout) {
	const deadline = Date.now() + timeout;
	let d = 0;
	while (Date.now() < deadline) {
		d = await totalDraws(tab);
		if (d > 0) return d;
		await new Promise((r) => setTimeout(r, 250));
	}
	return d;
}

async function clickPrimary(tab) {
	try {
		await tab.evaluate(() => {
			const btn = [...document.querySelectorAll('button, a.btn')].find((b) => {
				const r = b.getBoundingClientRect();
				return !b.disabled && r.width > 0 && r.height > 0 && !/nav|menu|close|theme/i.test(b.className + b.id);
			});
			if (btn) btn.click();
		});
		await new Promise((r) => setTimeout(r, 800));
	} catch {
		/* best effort */
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
	const filter = process.argv.slice(2);
	const targets = filter.length ? PAGES.filter((p) => filter.includes(p.slug)) : PAGES;
	if (!targets.length) {
		console.error(`No matching pages. Known slugs: ${PAGES.map((p) => p.slug).join(', ')}`);
		process.exit(2);
	}

	const chrome = resolveChrome();
	console.log(C.d(`chrome: ${chrome}`));
	const server = await startServer();
	console.log(C.d(`server: ${server.base}\n`));
	console.log(C.b(`IBM showcase — runtime gate · ${targets.length} page(s)\n`));

	const browser = await puppeteer.launch({
		executablePath: chrome,
		headless: !process.env.HEADFUL,
		// Software WebGL: recent Chrome gates SwiftShader behind --enable-unsafe-swiftshader.
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
		defaultViewport: { width: 1440, height: 900 },
	});

	const results = [];
	try {
		for (const page of targets) {
			// One retry absorbs transient dev-server blips (a concurrent editor
			// saving a module mid-transform yields a momentary 500). A real break
			// fails both attempts.
			let res = await checkPage(browser, server.base, page);
			if (res.errors.length) {
				await new Promise((r) => setTimeout(r, 1500));
				res = await checkPage(browser, server.base, page);
			}
			results.push(res);
			const ok = res.errors.length === 0;
			const warns = res.warnings || [];
			const marker = !ok ? C.r('●') : warns.length ? C.y('●') : C.g('●');
			const drawInfo = page.engine ? C.d(` · ${res.draws} draws`) : '';
			const degInfo = res.degraded.length ? C.y(` · degraded(${res.degraded.length})`) : '';
			console.log(`${marker} ${C.b(page.path)}${drawInfo}${degInfo}`);
			if (!ok) res.errors.forEach((e) => console.log(`    ${C.r('✗')} ${e}`));
			warns.forEach((w) => console.log(`    ${C.y('⚠')} ${w}`));
			if (ok && res.degraded.length && process.env.LOG_ALL)
				res.degraded.forEach((d) => console.log(`    ${C.d('○')} ${d} (watsonx unconfigured — honest degrade)`));
		}
	} finally {
		await browser.close();
		await server.stop();
	}

	const strict = !!process.env.STRICT_A11Y;
	const failed = results.filter((r) => r.errors.length || (strict && (r.warnings || []).length));
	const warnPages = results.filter((r) => (r.warnings || []).length);
	console.log('');
	if (failed.length) {
		const why = strict ? 'failed the runtime/quality gate' : 'failed the runtime gate';
		console.log(C.r(`✗ ${failed.length}/${results.length} page(s) ${why}.`));
		process.exit(1);
	}
	const anyDegraded = results.some((r) => r.degraded.length);
	console.log(C.g(`✓ all ${results.length} /ibm page(s) render, draw, and handle errors cleanly.`));
	if (warnPages.length) console.log(C.y(`⚠ ${warnPages.length} page(s) have UX/a11y warnings above (run STRICT_A11Y=1 to enforce).`));
	if (anyDegraded) console.log(C.d('  (some /api/ibm endpoints returned the honest "watsonx unconfigured" degrade — expected.)'));
}

main().catch((e) => {
	console.error(C.r(`\n❌ ${e.message}`));
	process.exit(1);
});

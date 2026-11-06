// Capture embodiment evidence: drive the live embed through idle, three
// sentiments (distinct expressions + lip-sync), a same-body reload, and a
// non-humanoid graceful fallback — screenshotting each and asserting a clean
// console. Run against a dev server: `node scripts/embodiment-evidence.mjs [baseUrl]`.
//
// Not committed as product code — it's a verification harness. Output lands in
// prompts/store-submissions/_generated/embodiment/.

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3002';
const GLB = `${BASE}/avatars/xbot.glb`;
const PROP = `${BASE}/accessories/hat-cowboy.glb`;
const OUT = path.resolve('prompts/store-submissions/_generated/embodiment');
const PERSONA_ID = 'persona_EvidenceDemo12345';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function embedUrl({ state, text, emotion, glb = GLB, name = 'Nova', persona = PERSONA_ID }) {
	const u = new URL(`${BASE}/embodiment/embed`);
	if (persona) u.searchParams.set('persona', persona);
	u.searchParams.set('glb', glb);
	u.searchParams.set('name', name);
	if (state) u.searchParams.set('state', state);
	if (text) u.searchParams.set('text', text);
	if (emotion) u.searchParams.set('emotion', emotion);
	return u.toString();
}

const errors = [];

async function shoot(page, url, file, { settle = 2600, speaking = false } = {}) {
	const localErrs = [];
	const onErr = (m) => { if (m.type() === 'error') localErrs.push(m.text()); };
	const onPage = (e) => localErrs.push(`pageerror: ${e.message}`);
	page.on('console', onErr);
	page.on('pageerror', onPage);
	await page.goto(url, { waitUntil: 'load' });
	// Wait for the canvas (body mounted) then let the rig settle / speech peak.
	await page.waitForSelector('canvas', { timeout: 20000 });
	await wait(settle);
	await page.screenshot({ path: path.join(OUT, file) });
	page.off('console', onErr);
	page.off('pageerror', onPage);
	// Ignore dev-only noise (Vite HMR websocket can't reach the Codespaces-forwarded
	// :3000 from our :3002 server; GPU-stall perf warnings from headless WebGL) and
	// benign network noise. Keep real script/page errors.
	const real = localErrs.filter(
		(t) => !/favicon|manifest\.json 404|ERR_ABORTED|websocket|WebSocket|vite\]|GPU stall|GL Driver/i.test(t),
	);
	if (real.length) errors.push({ file, real });
	console.log(`✓ ${file}${real.length ? `  (⚠ ${real.length} console errors)` : ''}`);
}

const shots = [
	{ file: '01-idle.png', url: embedUrl({ state: 'idle' }), opt: { settle: 3000 } },
	{ file: '02-joy.png', url: embedUrl({ state: 'speaking', emotion: 'joy', text: 'Congratulations, this is absolutely amazing news and I am so happy and thrilled for you today! 🎉' }), opt: { settle: 2400, speaking: true } },
	{ file: '03-sad.png', url: embedUrl({ state: 'speaking', emotion: 'sad', text: 'I am so sorry, but unfortunately that request failed and I could not recover it. I really regret the trouble this caused you.' }), opt: { settle: 2400, speaking: true } },
	{ file: '04-angry.png', url: embedUrl({ state: 'speaking', emotion: 'angry', text: 'This is completely unacceptable and honestly quite frustrating. That outcome is terrible and it should never have happened this way.' }), opt: { settle: 2400, speaking: true } },
	{ file: '05-reload-same-body.png', url: embedUrl({ state: 'idle' }), opt: { settle: 3000 } },
	{ file: '06-nonhumanoid-fallback.png', url: embedUrl({ state: 'idle', glb: PROP, name: 'Cowboy Hat', persona: null }), opt: { settle: 3000 } },
];

const browser = await chromium.launch();
try {
	await mkdir(OUT, { recursive: true });
	// Warm up the dev module graph (Vite compiles three + the stage on first hit)
	// so the first timed shot isn't racing a cold compile.
	{
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await page.goto(embedUrl({ state: 'idle' }), { waitUntil: 'load' }).catch(() => {});
		await page.waitForSelector('canvas', { timeout: 20000 }).catch(() => {});
		await wait(4000);
		await ctx.close();
	}
	for (const s of shots) {
		// A fresh context per shot = a genuinely new "session" (no shared state),
		// which is exactly what the reload-same-body case must prove.
		const ctx = await browser.newContext({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 2 });
		const page = await ctx.newPage();
		await shoot(page, s.url, s.file, s.opt);
		await ctx.close();
	}
} finally {
	await browser.close();
}

if (errors.length) {
	console.error('\n✗ console errors detected:');
	for (const e of errors) console.error(`  ${e.file}:`, e.real.slice(0, 3));
	process.exit(1);
}
console.log(`\nAll evidence captured to ${OUT} with a clean console.`);

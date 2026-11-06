// scripts/extension-screenshots.mjs
//
// Generates the complete Chrome Web Store listing asset set for the Walk Avatar
// extension into extensions/walk-avatar/store-assets/:
//
//   icon-128.png            — 128×128 store icon
//   promo-tile-440x280.png  — small promotional tile
//   marquee-1280x800.png    — marquee promotional image
//   screenshot-1..5.png     — 1280×800 screenshots of the real product
//
// Everything is captured from the real product with a real Chromium (Playwright):
//   • The popup and settings pages are the real extension pages, listing real
//     public three.ws avatars and the real voice catalog.
//   • The avatar is the real /walk-embed 3D render (WALK_EMBED_BASE, default
//     http://localhost:3000 so shots use the current source build).
//   • The host pages (article / social) are real, live websites.
//
// The avatar-on-a-site shots composite the real transparent avatar render over a
// real site screenshot. They are layered rather than captured in one frame only
// because headless software-GL Chromium cannot render WebGL inside a cross-origin
// iframe on a heavy host page without crashing — the pixels in both layers are
// the genuine product. In a real browser the extension renders the same avatar
// in-page directly.
//
// Prereqs: `npm run build:extension` (dist/extension) and a running source server
// at WALK_EMBED_BASE (`npm run dev`).
//
//   node scripts/extension-screenshots.mjs
//
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { TTS_VOICES, DEFAULT_VOICE } from '../api/_lib/tts-voices.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const EXT_DIST = join(root, 'dist', 'extension');
const OUT = join(root, 'extensions', 'walk-avatar', 'store-assets');
const BASE = (process.env.WALK_EMBED_BASE || 'http://localhost:3000').replace(/\/$/, '');
const THREEWS = 'https://three.ws';

const W = 1280;
const H = 800;
const GL_ARGS = ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--disable-gpu-process-crash-limit'];

mkdirSync(OUT, { recursive: true });

if (!existsSync(join(EXT_DIST, 'popup.html'))) {
	console.error('dist/extension not found — run `npm run build:extension` first.');
	process.exit(1);
}

// Software GL can SEGV the GPU process; retry the whole browser session.
async function withBrowser(fn, { attempts = 4, args = GL_ARGS } = {}) {
	let lastErr;
	for (let i = 0; i < attempts; i++) {
		const browser = await chromium.launch({ args });
		try {
			const out = await fn(browser);
			await browser.close();
			return out;
		} catch (err) {
			lastErr = err;
			await browser.close().catch(() => {});
			console.warn(`  retry ${i + 1}/${attempts}: ${String(err.message || err).split('\n')[0]}`);
		}
	}
	throw lastErr;
}

// ── Real public-avatar catalog (popup/options grids) ──────────────────────────
async function fetchPublicAvatars(limit = 48) {
	const res = await fetch(`${THREEWS}/api/avatars/public?limit=${limit}`, { headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`/api/avatars/public ${res.status}`);
	const body = await res.json();
	return (body.avatars || [])
		.filter((a) => a && a.id)
		.map((a) => ({
			id: a.id,
			name: a.name,
			thumb_url: a.thumbnail_url || null,
			thumbnail_url: a.thumbnail_url || null,
			has_thumbnail: Boolean(a.thumbnail_url),
			featured: Boolean(a.thumbnail_url),
			model_url: a.model_url,
		}))
		.sort((a, b) => Number(b.has_thumbnail) - Number(a.has_thumbnail));
}

// ── Real avatar render, transparent + trimmed ─────────────────────────────────
async function captureAvatar({ narrate = null } = {}) {
	const buf = await withBrowser(async (browser) => {
		const ctx = await browser.newContext({ viewport: { width: 460, height: 680 }, deviceScaleFactor: 2 });
		const page = await ctx.newPage();
		await page.goto(`${BASE}/walk-embed?controls=none&autoplay=true&ground=false&orbit=false&bg=transparent`, {
			waitUntil: 'domcontentloaded',
			timeout: 30000,
		});
		// Wait until the embed reports the avatar is up (status leaves "loading…").
		let ready = false;
		for (let i = 0; i < 16; i++) {
			await page.waitForTimeout(2000);
			const s = await page.evaluate(() => document.getElementById('walk-status')?.textContent || '');
			if (s && !/loading/i.test(s)) { ready = true; break; }
		}
		if (!ready) throw new Error('avatar did not finish loading');
		if (narrate) {
			await page.evaluate((text) => {
				window.postMessage({ type: 'walk:setMotion', motion: 'idle' }, '*');
				window.postMessage({ type: 'walk:narrate', text }, '*');
			}, narrate);
			await page.waitForTimeout(2500);
		} else {
			await page.waitForTimeout(800);
		}
		return page.screenshot({ omitBackground: true });
	});
	return sharp(buf).trim().png().toBuffer();
}

// ── Real site screenshot (no WebGL in the host page → stable) ──────────────────
async function dismissConsent(page) {
	for (const label of ['Accept all', 'Accept', 'I agree', 'Agree', 'Got it', 'Allow all']) {
		const btn = page.getByRole('button', { name: new RegExp(`^\\s*${label}\\s*$`, 'i') }).first();
		if (await btn.count().catch(() => 0)) {
			await btn.click({ timeout: 1500 }).catch(() => {});
			await page.waitForTimeout(300);
			break;
		}
	}
}
async function removeClutter(page) {
	await page.evaluate(() => {
		const sel = [
			'#siteNotice', '.mw-dismissable-notice', '#centralNotice', '.frb', '[class*="frbanner"]',
			'[id*="cookie"]', '[class*="cookie"]', '[id*="consent"]', '[class*="consent"]',
			'[class*="gdpr"]', '[aria-label*="cookie" i]',
		];
		for (const s of sel) document.querySelectorAll(s).forEach((el) => el.remove());
	}).catch(() => {});
}
async function captureSite(candidates) {
	return withBrowser(async (browser) => {
		const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
		const page = await ctx.newPage();
		let loaded = false;
		for (const url of candidates) {
			try {
				await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
				loaded = true;
				break;
			} catch { /* next */ }
		}
		if (!loaded) throw new Error(`no candidate loaded: ${candidates.join(', ')}`);
		await dismissConsent(page);
		await removeClutter(page);
		await page.waitForTimeout(1000);
		await removeClutter(page);
		return page.screenshot();
	});
}

// The product's narration speech bubble is a real DOM element (dark rounded card
// with a pointer, 3-line clamp) — see showSpeechBubble() in src/walk-embed.js.
// Headless software-GL fails to rasterize it (backdrop-filter over a transparent
// canvas), so for the listing shot we redraw it 1:1 with the same narration copy.
function speechBubbleSvg(text) {
	const max = 34;
	const words = text.split(' ');
	const lines = [];
	let cur = '';
	for (const w of words) {
		if ((cur + ' ' + w).trim().length > max) { lines.push(cur.trim()); cur = w; } else { cur += ' ' + w; }
		if (lines.length === 3) break;
	}
	if (cur.trim() && lines.length < 3) lines.push(cur.trim());
	const w = 300, lh = 21, padY = 14;
	const h = padY * 2 + lines.length * lh;
	const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
	const tspans = lines.map((l, i) => `<text x="16" y="${padY + 15 + i * lh}" font-family="Inter,system-ui,sans-serif" font-size="13.5" fill="#fafafa">${esc(l)}</text>`).join('');
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + 8}">
		<rect x="0" y="0" width="${w}" height="${h}" rx="14" fill="rgba(10,10,10,0.92)" stroke="rgba(255,255,255,0.14)"/>
		<path d="M ${w / 2 - 7} ${h} L ${w / 2 + 7} ${h} L ${w / 2} ${h + 8} Z" fill="rgba(10,10,10,0.92)"/>
		${tspans}
	</svg>`;
	return { buf: Buffer.from(svg), width: w, height: h + 8 };
}

// ── Composite the real avatar over the real site ──────────────────────────────
async function compositeAvatar(siteBuf, avatarBuf, { heightPx = 380, margin = 26, position = 'bottom-right', bubble = null } = {}) {
	const av = await sharp(avatarBuf).resize({ height: heightPx }).png().toBuffer();
	const m = await sharp(av).metadata();
	const aw = m.width || 240, ah = m.height || heightPx;
	const left = position.includes('left') ? margin : W - aw - margin;
	const top = H - ah - margin + 8;
	const layers = [{ input: av, left: Math.round(left), top: Math.round(top) }];
	if (bubble) {
		const b = speechBubbleSvg(bubble);
		const bLeft = Math.max(12, Math.round(left + aw / 2 - b.width / 2));
		const bTop = Math.max(12, Math.round(top + ah * 0.06 - b.height));
		layers.push({ input: await sharp(b.buf).png().toBuffer(), left: bLeft, top: bTop });
	}
	return sharp(siteBuf).composite(layers).png().toBuffer();
}

// ── Extension pages: static server + chrome.* shim + real API routing ─────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveExtension() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const path = decodeURIComponent((req.url || '/').split('?')[0]);
			const file = join(EXT_DIST, path === '/' ? 'popup.html' : path);
			if (!file.startsWith(EXT_DIST) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
			res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
			res.end(readFileSync(file));
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}
function chromeShim(cfg) {
	return `(${((c) => {
		const store = { sync: { ...c.sync }, local: { ...c.local }, session: {} };
		const area = (name) => ({
			get(keys) {
				const s = store[name];
				let out = {};
				if (keys == null) out = { ...s };
				else if (typeof keys === 'string') out = { [keys]: s[keys] };
				else if (Array.isArray(keys)) keys.forEach((k) => (out[k] = s[k]));
				else out = Object.fromEntries(Object.keys(keys).map((k) => [k, s[k] ?? keys[k]]));
				return Promise.resolve(out);
			},
			set(obj) { Object.assign(store[name], obj); return Promise.resolve(); },
			remove(k) { delete store[name][k]; return Promise.resolve(); },
		});
		const replies = {
			'get-state': { session: c.session, settings: store.sync },
			'check-site': { allowed: true }, 'toggle-tab': { ok: true }, 'update-settings': { ok: true },
			'set-avatar': { ok: true }, 'clear-session': { ok: true },
		};
		window.chrome = {
			runtime: {
				sendMessage: (m) => Promise.resolve(replies[m && m.type] ?? {}),
				onMessage: { addListener() {}, removeListener() {} },
				openOptionsPage() {}, getManifest: () => ({ version: c.version }), getURL: (p) => p, lastError: null,
			},
			storage: { sync: area('sync'), local: area('local'), session: area('session') },
			tabs: {
				query: () => Promise.resolve([{ id: 1, url: c.currentUrl, title: 'Example' }]),
				get: () => Promise.resolve({ id: 1, url: c.currentUrl }),
				create() {}, remove() {}, sendMessage() {}, onUpdated: { addListener() {} },
			},
		};
	}).toString()})(${JSON.stringify(cfg)})`;
}
async function routeApi(context, avatars, allowOrigin) {
	await context.route('**/three.ws/api/**', async (route) => {
		const url = route.request().url();
		// popup.js / options.js fetch with credentials:'include' — CORS forbids a
		// wildcard ACAO with credentials, so reflect the caller's origin.
		const origin = route.request().headers()['origin'] || allowOrigin || '*';
		const reply = (obj) => route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
			body: JSON.stringify(obj),
		});
		if (/\/api\/avatars(\/(mine|featured|public))?(\?|$)/.test(url)) return reply({ avatars });
		if (/\/api\/tts\/voices\b/.test(url)) return reply({ enabled: true, default: DEFAULT_VOICE, voices: TTS_VOICES, providers: { nvidia: true, openai: true } });
		if (/\/api\/(me|threews\/me)\b/.test(url)) return reply({ user: { handle: '@you', username: 'you' } });
		return route.continue();
	});
}

// Compose a small extension surface onto a branded 1280×800 frame.
async function composeSurface(shotBuf, outName, caption) {
	const bg = await sharp(tileSvg(W, H, { title: '', sub: '' })).png().toBuffer();
	// Scale the surface to comfortably fit inside the frame (room for caption).
	const maxW = W - 200, maxH = H - 170;
	let shot = shotBuf;
	const m0 = await sharp(shotBuf).metadata();
	if (m0.width > maxW || m0.height > maxH) {
		shot = await sharp(shotBuf).resize({ width: maxW, height: maxH, fit: 'inside' }).png().toBuffer();
	}
	const meta = await sharp(shot).metadata();
	const sw = meta.width, sh = meta.height;
	const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}"><rect width="${sw}" height="${sh}" rx="16" ry="16"/></svg>`);
	const rounded = await sharp(shot).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
	const left = Math.round((W - sw) / 2);
	const top = Math.round((H - sh) / 2) - 20;
	const shadow = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${left - 6}" y="${top + 12}" width="${sw + 12}" height="${sh + 12}" rx="22" fill="#000" opacity="0.5"/></svg>`);
	const cap = caption ? [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="80"><text x="${W / 2}" y="46" text-anchor="middle" font-family="'Inter',system-ui,sans-serif" font-size="24" font-weight="600" fill="#fafafa">${caption}</text></svg>`), left: 0, top: H - 96 }] : [];
	await sharp(bg).composite([{ input: await sharp(shadow).blur(14).png().toBuffer(), left: 0, top: 0 }, { input: rounded, left, top }, ...cap]).png().toFile(join(OUT, outName));
	console.log(`✓ ${outName}`);
}

async function snapExtensionPage(extBase, avatars, { file, viewport, shim, tabName, thumbSel, then }) {
	return withBrowser(async (browser) => {
		const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
		await routeApi(ctx, avatars, extBase);
		const page = await ctx.newPage();
		await page.addInitScript(shim);
		await page.goto(`${extBase}/${file}`, { waitUntil: 'domcontentloaded' });
		if (tabName) await page.getByRole('tab', { name: tabName }).click().catch(() => {});
		if (thumbSel) await page.waitForSelector(thumbSel, { timeout: 15000 }).catch(() => {});
		await page.waitForTimeout(2500);
		return then(page);
	}, { args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}

// ── Listing graphics ──────────────────────────────────────────────────────────
const ICON_SVG = readFileSync(join(root, 'public', 'pwa-icon.svg'));
function tileSvg(w, h, { title, sub, big = 40, small = 19 }) {
	return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a0e16"/><stop offset="0.55" stop-color="#0d1422"/><stop offset="1" stop-color="#0a0a0a"/></linearGradient>
		<radialGradient id="glow" cx="78%" cy="28%" r="60%"><stop offset="0" stop-color="#7dd3fc" stop-opacity="0.22"/><stop offset="1" stop-color="#7dd3fc" stop-opacity="0"/></radialGradient>
	</defs>
	<rect width="${w}" height="${h}" fill="url(#bg)"/>
	<rect width="${w}" height="${h}" fill="url(#glow)"/>
	<text x="50" y="${h / 2 - 8}" font-family="'Space Grotesk','Inter',system-ui,sans-serif" font-size="${big}" font-weight="700" fill="#fafafa">${title}</text>
	<text x="52" y="${h / 2 + 26}" font-family="'Inter',system-ui,sans-serif" font-size="${small}" fill="#a1a1aa">${sub}</text>
</svg>`);
}
async function buildIcon() {
	await sharp(ICON_SVG).resize(128, 128).png().toFile(join(OUT, 'icon-128.png'));
	console.log('✓ icon-128.png');
}
async function buildPromoTile() {
	const w = 440, h = 280, iconSize = 132;
	const bg = await sharp(tileSvg(w, h, { title: 'Walk Avatar', sub: 'Your 3D companion, on every site', big: 34, small: 15 })).png().toBuffer();
	const icon = await sharp(ICON_SVG).resize(iconSize, iconSize).png().toBuffer();
	await sharp(bg).composite([{ input: icon, left: w - iconSize - 28, top: (h - iconSize) / 2 }]).png().toFile(join(OUT, 'promo-tile-440x280.png'));
	console.log('✓ promo-tile-440x280.png');
}
async function buildMarquee(avatarBuf) {
	const w = 1280, h = 800;
	const bg = await sharp(tileSvg(w, h, { title: 'three.ws · Walk Avatar', sub: 'Walk your 3D avatar on any website — and have it read pages aloud.', big: 58, small: 24 })).png().toBuffer();
	const icon = await sharp(ICON_SVG).resize(180, 180).png().toBuffer();
	const composites = [{ input: icon, left: 50, top: 70 }];
	if (avatarBuf) {
		const fig = await sharp(avatarBuf).resize({ height: 620 }).png().toBuffer();
		const m = await sharp(fig).metadata();
		composites.push({ input: fig, left: w - (m.width || 360) - 70, top: h - (m.height || 620) - 20 });
	}
	await sharp(bg).composite(composites).png().toFile(join(OUT, 'marquee-1280x800.png'));
	console.log('✓ marquee-1280x800.png');
}

// ── Main ──────────────────────────────────────────────────────────────────────
const avatars = await fetchPublicAvatars(48);
console.log(`Loaded ${avatars.length} real public avatars for the grids.`);

const extServer = await serveExtension();
const extBase = `http://127.0.0.1:${extServer.address().port}`;

try {
	// Real avatar renders (reused across the on-site shots + marquee).
	console.log('Rendering avatar (walking)…');
	const avatarWalk = await captureAvatar();
	console.log('Rendering avatar (narrating)…');
	const avatarTalk = await captureAvatar({ narrate: 'Let me read this story to you while you keep browsing — tap me to mute any time.' });

	// 1: avatar on a real content/article page
	const site1 = await captureSite(['https://en.wikipedia.org/wiki/Web_browser', 'https://en.wikipedia.org/wiki/World_Wide_Web']);
	await sharp(await compositeAvatar(site1, avatarWalk, { heightPx: 400 })).toFile(join(OUT, 'screenshot-1.png'));
	console.log('✓ screenshot-1.png (avatar on an article page)');

	// 4: avatar narrating with its speech bubble, on a real news page
	const NARRATION = 'Let me read this story to you while you keep browsing — tap me to mute any time.';
	const site4 = await captureSite(['https://text.npr.org', 'https://en.wikipedia.org/wiki/Three.js']);
	await sharp(await compositeAvatar(site4, avatarTalk, { heightPx: 440, bubble: NARRATION })).toFile(join(OUT, 'screenshot-4.png'));
	console.log('✓ screenshot-4.png (avatar narrating)');

	// 5: avatar on a real social page
	const site5 = await captureSite(['https://mastodon.social/public/local', 'https://mastodon.social/explore', 'https://en.wikipedia.org/wiki/Social_media']);
	await sharp(await compositeAvatar(site5, avatarWalk, { heightPx: 400, position: 'bottom-right' })).toFile(join(OUT, 'screenshot-5.png'));
	console.log('✓ screenshot-5.png (avatar on a social page)');

	// 2: popup with the avatar selection grid (real public avatars)
	const popupShot = await snapExtensionPage(extBase, avatars, {
		file: 'popup.html',
		viewport: { width: 360, height: 600 },
		shim: chromeShim({ version: '1.0.0', currentUrl: 'https://en.wikipedia.org/wiki/Web_browser', session: null, sync: { walkSpeed: 1.2, position: 'bottom-right', sizePreset: 'medium', narrationEnabled: true, voice: DEFAULT_VOICE }, local: {} }),
		tabName: /featured/i,
		thumbSel: '.avatar-thumb:not(.skeleton)',
		then: (page) => page.screenshot(),
	});
	await composeSurface(popupShot, 'screenshot-2.png', 'Pick any avatar — your own or a featured 3D character');

	// 3: settings page
	const optsShot = await snapExtensionPage(extBase, avatars, {
		file: 'options.html',
		viewport: { width: 940, height: 720 },
		shim: chromeShim({ version: '1.0.0', currentUrl: 'https://three.ws', session: 'demo-session', sync: { walkSpeed: 1.2, position: 'bottom-right', sizePreset: 'medium', narrationEnabled: true, voice: DEFAULT_VOICE }, local: {} }),
		tabName: /featured/i,
		thumbSel: '.av-thumb:not(.skeleton)',
		then: (page) => page.screenshot(),
	});
	await composeSurface(optsShot, 'screenshot-3.png', 'Set defaults, narration voice, and per-site rules');

	// Listing graphics
	await buildIcon();
	await buildPromoTile();
	await buildMarquee(avatarWalk);
} finally {
	extServer.close();
}

console.log(`\nAll store assets written to ${OUT}`);

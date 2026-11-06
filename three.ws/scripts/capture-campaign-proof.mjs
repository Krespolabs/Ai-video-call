#!/usr/bin/env node
/**
 * capture-campaign-proof.mjs: the "visible proof" for every anchor campaign in
 * marketing/growth/campaigns.csv, captured from the live product.
 *
 * The growth plan says every anchor campaign leads with visible proof: a still
 * that reads at a glance and, where the surface moves, a short clip of it
 * moving. This script derives that proof from the campaign sheet itself, so a
 * new anchor row is one command away from having its media, and re-running it
 * on posting day re-derives every file from what production serves right now.
 *
 * For each `anchor` row whose anchor_proof is a three.ws URL it writes, under
 * marketing/growth/proof/<campaign_id>/:
 *
 *   desktop@2x.png     1600x900 viewport at deviceScaleFactor 2 (3200x1800), for
 *                      (desktop@1x.png for WebGL recipes with `scale: 1`: a 2x
 *                      SwiftShader framebuffer plus the recorder can take the
 *                      headless renderer down on a busy machine)
 *                      articles, partner pages and press
 *   x-1600x900.jpg     the same frame at exactly 1600x900, JPEG, under X's 5 MB
 *                      image limit, ready to attach to a post
 *   mobile@3x.png      390x844 viewport at deviceScaleFactor 3 (1170x2532); WebGL
 *                      recipes may set `mobileScale: 2` for the same reason
 *   motion-15s.mp4     (motion surfaces only) 15 seconds of the running page,
 *                      H.264 + faststart, kept under 8 MB
 *
 * It also records what went wrong while it looked: console errors, uncaught
 * exceptions, failed same-origin requests, error or 404 pages, and a WebGL
 * canvas that never painted. Those land in proof/manifest.json and in the
 * generated tables of proof/README.md, so a broken proof page is reported
 * instead of silently photographed.
 *
 * Commit gate: the growth repo only promotes $THREE. A frame whose visible text
 * names another coin or token (beyond the approved payment rails in
 * APPROVED_TOKEN_TERMS) is flagged `gated` in the manifest, and the
 * console prints the exact terms; those files stay out of commits until the
 * owner approves them.
 *
 * Usage:
 *   node scripts/capture-campaign-proof.mjs                       # every anchor row
 *   node scripts/capture-campaign-proof.mjs --only MKT-2026-10-NVIDIA-DH
 *   node scripts/capture-campaign-proof.mjs --no-video            # stills only
 *   node scripts/capture-campaign-proof.mjs --base http://localhost:3000
 *
 * The capture engine follows scripts/capture-doc-media.mjs (same site-chrome
 * hiding, same SwiftShader flags, same CDP screenshot fallback for pages whose
 * WebGL loop never yields a stable frame). It is a separate entry point because
 * its inputs (the campaign sheet) and outputs (PNG/JPEG stills plus a real
 * H.264 recording, not WebP figures) differ from the docs pipeline.
 */
import { chromium, devices } from 'playwright';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAMPAIGNS = path.join(ROOT, 'marketing/growth/campaigns.csv');
const PROOF_DIR = path.join(ROOT, 'marketing/growth/proof');
const MANIFEST = path.join(PROOF_DIR, 'manifest.json');
const README = path.join(PROOF_DIR, 'README.md');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE = opt('base', 'https://three.ws').replace(/\/$/, '');
const ONLY = opt('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const WITH_VIDEO = !flag('no-video');
const CLIP_SECONDS = 15;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;
const MAX_X_BYTES = 5 * 1024 * 1024;
const CHILD_TIMEOUT_MS = 12 * 60 * 1000;

const DESKTOP = { width: 1600, height: 900 };
const MOBILE = devices['iPhone 13'];

// Floating chrome that follows a visitor across routes and parks over the
// subject. Framing it out is a crop, not an edit of the product surface.
const SITE_CHROME = [
	'#tws-corner-stack',
	'.tws-corner-item',
	'.tws-disc-card',
	'.tws-atlas-hint',
	'.twx-i18n-fab',
	'lang-switcher',
	'.walk-companion',
	'.walk-trail-layer',
	'.walk-c2w-fx',
	'#cookie-banner',
	'.cookie-banner',
	'[data-consent-banner]',
];

/**
 * Per-campaign framing. Anything not listed here is captured as a still at the
 * top of its anchor_proof page. `motion` records the clip, `canvas` waits for a
 * WebGL canvas to paint, `actions` run before the stills, and `clipActions`
 * run inside the recorded window so the clip shows the surface being used.
 */
const RECIPES = {
	'MKT-2026-09-IBM-EVENT': {
		scale: 1,
		mobileScale: 2,
		shows: 'The live 3D world at /play, the venue for the IBM Community user-group event',
		motion: true,
		canvas: true,
		settle: 12000,
		clipActions: [{ type: 'orbit' }],
	},
	'MKT-2026-11-IBM-WORLD-2': {
		scale: 1,
		mobileScale: 2,
		shows: 'The live 3D world at /play, where the second IBM session runs the tool-purchase demo',
		motion: true,
		canvas: true,
		settle: 12000,
		clipActions: [{ type: 'orbit' }],
	},
	'MKT-2026-09-OPENAI-STUDIO': {
		shows: 'The OpenAI Select Partner page: 3D Studio inside ChatGPT, keyless',
	},
	'MKT-2026-10-NVIDIA-DH': {
		scale: 1,
		mobileScale: 2,
		shows: 'The Audio2Face demo: audio driving a 3D face in the browser',
		motion: true,
		canvas: true,
		settle: 12000,
		// Press Speak inside the clip: NVIDIA Magpie voices the line and Audio2Face
		// streams the blendshape frames that move the face.
		clipActions: [{ type: 'click', selector: '#speak' }],
	},
	'MKT-2026-10-CDP-X402': {
		shows: 'The x402 Bazaar: a live catalog of paid APIs an agent can discover and buy',
	},
	'MKT-2026-10-AWS-MARKET': {
		shows: 'The three.ws on AWS page: the AWS Partner software path and procurement story',
	},
	'MKT-2026-10-ELEVEN-BODY': {
		scale: 1,
		mobileScale: 2,
		shows: 'The voice page: a voice agent with a speaking, expressive 3D body',
		motion: true,
		canvas: true,
		settle: 12000,
	},
	'MKT-2026-11-GCP-AGENT': {
		shows: 'The public A2A Agent Card served at /.well-known/agent-card.json',
		json: true,
	},
	'MKT-2026-11-QUICKNODE': {
		shows: 'The Solana agents doc, Networks section: the production RPC failover chain',
		actions: [{ type: 'heading', text: 'Networks' }],
		mobileActions: [{ type: 'heading', text: 'Networks', offset: 72 }],
	},
};

// Visible text naming a coin or token other than $THREE. Solana, the home
// chain, is the platform's own rail and is not flagged by name.
const OTHER_TOKEN = /\$(?!THREE\b)[A-Z][A-Z0-9]{1,9}\b|\b(?:USDC|USDT|SOL|ETH|WETH|BTC|BONK|WIF|JUP|PYUSD|EURC|Bitcoin|Ethereum)\b/g;

function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			if (row.some((f) => f !== '')) rows.push(row);
			row = [];
			field = '';
		} else field += c;
	}
	if (field !== '' || row.length) {
		row.push(field);
		rows.push(row);
	}
	const [header, ...body] = rows;
	return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function anchorCampaigns() {
	return parseCsv(readFileSync(CAMPAIGNS, 'utf8')).filter((row) => row.type === 'anchor');
}

function targetUrl(proof) {
	const url = new URL(proof);
	if (url.hostname !== 'three.ws') return null;
	return BASE + url.pathname + url.search;
}

async function newContext(browser, kind, videoDir, scale = kind === 'mobile' ? 3 : 2) {
	const context = await browser.newContext(
		kind === 'mobile'
			? { ...MOBILE, viewport: { width: 390, height: 844 }, deviceScaleFactor: scale, colorScheme: 'dark' }
			: {
					viewport: DESKTOP,
					deviceScaleFactor: scale,
					colorScheme: 'dark',
					...(videoDir ? { recordVideo: { dir: videoDir, size: DESKTOP } } : {}),
				},
	);
	await context.addInitScript(() => {
		try {
			localStorage.setItem('twx_theme', 'dark');
		} catch {
			/* storage blocked: the colorScheme hint still applies */
		}
	});
	await context.addInitScript((css) => {
		const install = () => {
			const style = document.createElement('style');
			style.textContent = css;
			document.head?.appendChild(style);
		};
		if (document.head) install();
		else document.addEventListener('DOMContentLoaded', install, { once: true });
	}, `${SITE_CHROME.join(',')}{display:none !important}`);
	return context;
}

/** Wire the listeners that turn a page visit into a defect report. */
function watch(page, origin) {
	const report = { console: [], exceptions: [], failedRequests: [], crashed: false };
	page.on('console', (msg) => {
		if (msg.type() === 'error') report.console.push(msg.text().slice(0, 300));
	});
	page.on('pageerror', (err) => report.exceptions.push(String(err.message).slice(0, 300)));
	page.on('crash', () => {
		report.crashed = true;
	});
	page.on('response', (res) => {
		if (res.status() >= 400 && res.url().startsWith(origin)) {
			report.failedRequests.push(`${res.status()} ${res.url().slice(origin.length, origin.length + 160)}`);
		}
	});
	return report;
}

async function applyActions(page, actions = []) {
	for (const action of actions) {
		if (action.type === 'click') await page.click(action.selector, { timeout: action.timeout || 15000 });
		else if (action.type === 'wait') await page.waitForTimeout(action.ms || 1000);
		else if (action.type === 'scroll') await page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), action.top || 0);
		else if (action.type === 'orbit') await orbit(page, action.ms || 9000);
		else if (action.type === 'heading') await scrollToHeading(page, action.text, action.offset ?? 96);
		else throw new Error(`unknown action type "${action.type}"`);
	}
}

/** Put the first heading whose text starts with `text` near the top of the viewport. */
async function scrollToHeading(page, text, offset) {
	const found = await page.evaluate(({ text, offset }) => {
		const heading = [...document.querySelectorAll('h1,h2,h3')].find((h) => h.textContent.trim().startsWith(text));
		if (!heading) return false;
		window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - offset);
		return true;
	}, { text, offset });
	if (!found) throw new Error(`heading not found on page: ${text}`);
	await page.waitForTimeout(1200);
}

/** Drag slowly across the largest canvas so a 3D scene visibly turns. */
async function orbit(page, ms) {
	const box = await largestCanvasBox(page);
	if (!box) return;
	const y = box.y + box.height * 0.55;
	const from = box.x + box.width * 0.35;
	const to = box.x + box.width * 0.65;
	await page.mouse.move(from, y);
	await page.mouse.down();
	const steps = 60;
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(from + ((to - from) * i) / steps, y, { steps: 1 });
		await page.waitForTimeout(ms / steps);
	}
	await page.mouse.up();
}

async function largestCanvasBox(page) {
	return page.evaluate(() => {
		let best = null;
		for (const c of document.querySelectorAll('canvas')) {
			const r = c.getBoundingClientRect();
			const visible = r.width * r.height;
			if (r.width >= 200 && r.height >= 200 && (!best || visible > best.width * best.height)) {
				best = { x: r.x, y: r.y, width: r.width, height: r.height };
			}
		}
		return best;
	});
}

async function load(page, url, recipe) {
	const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
	await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {
		/* live 3D and streaming routes may never go idle; the settle covers them */
	});
	await page.evaluate(() => document.fonts?.ready).catch(() => {});
	if (recipe.canvas) {
		await page
			.waitForFunction(
				() => [...document.querySelectorAll('canvas')].some((c) => {
					const r = c.getBoundingClientRect();
					return r.width >= 200 && r.height >= 200;
				}),
				null,
				{ timeout: 60000 },
			)
			.catch(() => {});
	}
	await page.waitForTimeout(recipe.settle ?? 5000);
	await applyActions(page, recipe.actions);
	return response?.status() ?? 0;
}

/** Playwright screenshot, falling back to a raw CDP grab when a WebGL loop never settles. */
async function shoot(page) {
	try {
		return await page.screenshot({ type: 'png', timeout: 30000 });
	} catch (err) {
		if (!/timeout/i.test(String(err?.message))) throw err;
		const session = await page.context().newCDPSession(page);
		try {
			const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
			return Buffer.from(data, 'base64');
		} finally {
			await session.detach().catch(() => {});
		}
	}
}

/** Visible-in-viewport text, used for the error-page check and the token gate. */
async function visibleText(page) {
	return page.evaluate(() => {
		const out = [];
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const el = n.parentElement;
			if (!el || !n.textContent.trim()) continue;
			const style = getComputedStyle(el);
			if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
			const r = el.getBoundingClientRect();
			if (r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && r.width > 0) {
				out.push(n.textContent.trim());
			}
		}
		const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.alt);
		return { text: out.join(' '), alts: alts.join(' '), title: document.title, bodyLength: document.body.innerText.length };
	});
}

function pageDefects(status, seen, url) {
	const defects = [];
	if (status >= 400) defects.push(`HTTP ${status} for ${url}`);
	if (/\b404\b|page not found|something went wrong|application error/i.test(`${seen.title} ${seen.text.slice(0, 600)}`)) {
		defects.push('the page renders an error or not-found state');
	}
	if (seen.bodyLength < 40) defects.push('the page body is effectively empty');
	return defects;
}

/** True when the canvas region of a screenshot is a flat fill, which means WebGL never painted. */
async function canvasIsBlank(png, box, scale) {
	if (!box) return true;
	const meta = await sharp(png).metadata();
	const left = Math.max(0, Math.round(box.x * scale));
	const top = Math.max(0, Math.round(box.y * scale));
	const width = Math.min(meta.width - left, Math.round(box.width * scale));
	const height = Math.min(meta.height - top, Math.round(box.height * scale));
	if (width < 10 || height < 10) return true;
	const stats = await sharp(png).extract({ left, top, width, height }).stats();
	return stats.channels.slice(0, 3).every((c) => c.stdev < 3);
}

// Payment rails the owner approved showing in proof media (2026-09-18): a
// three.ws page that prices a call in USDC or SOL is showing how the product
// charges, not promoting a coin. Any other token name still holds the file.
const APPROVED_TOKEN_TERMS = new Set(['USDC', 'SOL']);
const isGated = (terms) => terms.some((t) => !APPROVED_TOKEN_TERMS.has(t));

function tokenMentions(seen) {
	const hits = new Set();
	for (const m of `${seen.text} ${seen.alts}`.matchAll(OTHER_TOKEN)) hits.add(m[0]);
	return [...hits];
}

async function durationOf(file) {
	const { stderr } = await run(ffmpegPath, ['-hide_banner', '-i', file], { maxBuffer: 1 << 24 }).catch((e) => e);
	const m = String(stderr).match(/Duration: (\d+):(\d+):([\d.]+)/);
	return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** Trim the recording to the clip window and encode H.264, raising CRF until it fits the size budget. */
async function encodeClip(webm, startSeconds, outFile) {
	for (const crf of [24, 28, 32, 36]) {
		await run(ffmpegPath, [
			'-y', '-loglevel', 'error',
			'-ss', startSeconds.toFixed(2),
			'-i', webm,
			'-t', String(CLIP_SECONDS),
			'-vf', `fps=30,scale=${DESKTOP.width}:${DESKTOP.height}:flags=lanczos,format=yuv420p`,
			'-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
			'-profile:v', 'high', '-movflags', '+faststart', '-an',
			outFile,
		], { maxBuffer: 1 << 24 });
		if (statSync(outFile).size <= MAX_VIDEO_BYTES) return;
	}
	throw new Error(`clip still exceeds ${MAX_VIDEO_BYTES} bytes at the highest CRF`);
}

function fileEntry(campaign, file, extra) {
	const full = path.join(PROOF_DIR, campaign, file);
	return {
		file: `${campaign}/${file}`,
		bytes: statSync(full).size,
		sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
		...extra,
	};
}

async function captureCampaign(browser, row, recipe) {
	const id = row.campaign_id;
	const url = targetUrl(row.anchor_proof);
	const dir = path.join(PROOF_DIR, id);
	mkdirSync(dir, { recursive: true });
	const capturedAt = new Date().toISOString();
	const files = [];
	const defects = [];
	const gatedTerms = new Set();
	const origin = new URL(url).origin;
	const recordClip = WITH_VIDEO && recipe.motion;
	const videoDir = recordClip ? mkdtempSync(path.join(tmpdir(), 'campaign-proof-')) : null;

	try {
		// Desktop: stills first, then the recorded clip window on the same visit.
		const scale = recipe.scale ?? 2;
		const heroFile = `desktop@${scale}x.png`;
		const desktop = await newContext(browser, 'desktop', videoDir, scale);
		const recordingStarted = Date.now();
		const page = await desktop.newPage();
		const report = watch(page, origin);
		let clipStart = 0;
		try {
			const status = await load(page, url, recipe);
			const seen = await visibleText(page);
			defects.push(...pageDefects(status, seen, url));
			const png = await shoot(page);
			if (recipe.canvas) {
				const box = await largestCanvasBox(page);
				if (await canvasIsBlank(png, box, scale)) defects.push('no WebGL canvas painted within the settle window');
			}
			const terms = tokenMentions(seen);
			terms.forEach((t) => gatedTerms.add(t));
			const hero = await sharp(png).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
			writeFileSync(path.join(dir, heroFile), hero);
			for (const other of [1, 2]) if (other !== scale) rmSync(path.join(dir, `desktop@${other}x.png`), { force: true });
			const heroMeta = await sharp(hero).metadata();
			files.push(fileEntry(id, heroFile, {
				kind: 'desktop', width: heroMeta.width, height: heroMeta.height, gated: isGated(terms),
				shows: `Desktop hero at 1600x900 (${scale}x): ${recipe.shows}`,
			}));

			let quality = 90;
			let xJpeg = await sharp(png).resize(1600, 900, { kernel: 'lanczos3' }).jpeg({ quality, mozjpeg: true }).toBuffer();
			while (xJpeg.length > MAX_X_BYTES && quality > 60) {
				quality -= 10;
				xJpeg = await sharp(png).resize(1600, 900, { kernel: 'lanczos3' }).jpeg({ quality, mozjpeg: true }).toBuffer();
			}
			writeFileSync(path.join(dir, 'x-1600x900.jpg'), xJpeg);
			files.push(fileEntry(id, 'x-1600x900.jpg', {
				kind: 'x', width: 1600, height: 900, gated: isGated(terms),
				shows: `X post still, 16:9 JPEG under 5 MB: ${recipe.shows}`,
			}));

			if (recordClip) {
				clipStart = (Date.now() - recordingStarted) / 1000;
				const clipEnds = Date.now() + CLIP_SECONDS * 1000;
				await applyActions(page, recipe.clipActions);
				const remaining = clipEnds - Date.now();
				if (remaining > 0) await page.waitForTimeout(remaining + 500);
			}
		} finally {
			if (report.crashed) defects.push('the renderer crashed while loading the page');
			if (report.exceptions.length) defects.push(...report.exceptions.map((e) => `uncaught exception: ${e}`));
			if (report.console.length) defects.push(...[...new Set(report.console)].slice(0, 10).map((e) => `console error: ${e}`));
			if (report.failedRequests.length) defects.push(...[...new Set(report.failedRequests)].slice(0, 10).map((e) => `failed request: ${e}`));
			await desktop.close();
		}

		if (recordClip) {
			const webm = await page.video()?.path();
			if (webm && existsSync(webm)) {
				const mp4 = path.join(dir, 'motion-15s.mp4');
				await encodeClip(webm, clipStart, mp4);
				files.push(fileEntry(id, 'motion-15s.mp4', {
					kind: 'video', width: DESKTOP.width, height: DESKTOP.height,
					durationSeconds: Math.round((await durationOf(mp4)) * 10) / 10,
					gated: isGated([...gatedTerms]),
					shows: `15 second H.264 recording of the live surface: ${recipe.shows}`,
				}));
			} else defects.push('the desktop recording produced no video file');
		}

		// Mobile: a separate visit with a phone viewport, touch and UA.
		const mobileScale = recipe.mobileScale ?? 3;
		const mobileFile = `mobile@${mobileScale}x.png`;
		const mobile = await newContext(browser, 'mobile', null, mobileScale);
		const mpage = await mobile.newPage();
		const mreport = watch(mpage, origin);
		try {
			const status = await load(mpage, url, { ...recipe, actions: recipe.mobileActions });
			const seen = await visibleText(mpage);
			for (const d of pageDefects(status, seen, url)) defects.push(`mobile: ${d}`);
			const terms = tokenMentions(seen);
			terms.forEach((t) => gatedTerms.add(t));
			const png = await shoot(mpage);
			const out = await sharp(png).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
			writeFileSync(path.join(dir, mobileFile), out);
			for (const other of [2, 3]) if (other !== mobileScale) rmSync(path.join(dir, `mobile@${other}x.png`), { force: true });
			const meta = await sharp(out).metadata();
			files.push(fileEntry(id, mobileFile, {
				kind: 'mobile', width: meta.width, height: meta.height, gated: isGated(terms),
				shows: `Mobile at 390x844 (${mobileScale}x): ${recipe.shows}`,
			}));
		} finally {
			if (mreport.crashed) defects.push('mobile: the renderer crashed while loading the page');
			for (const e of mreport.exceptions) defects.push(`mobile: uncaught exception: ${e}`);
			await mobile.close();
		}
	} finally {
		if (videoDir) rmSync(videoDir, { recursive: true, force: true });
	}

	return { campaign: id, publishDate: row.publish_date, partner: row.partner, url, capturedAt, files, defects: [...new Set(defects)], gatedTerms: [...gatedTerms] };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/[\u2013\u2014]/g, '-');

function renderTables(manifest) {
	const lines = [
		'| Campaign | File | Dimensions | Duration | Size | Captured URL | Capture date | What it shows |',
		'| --- | --- | --- | --- | --- | --- | --- | --- |',
	];
	const skipped = [];
	for (const c of manifest.campaigns) {
		if (!c.url) {
			skipped.push(c);
			continue;
		}
		for (const f of c.files) {
			const name = f.file.split('/').pop();
			const link = f.gated ? `\`${name}\` (held for owner approval, not committed)` : `[${name}](./${f.file})`;
			lines.push(`| ${c.campaign} | ${link} | ${f.width}x${f.height} | ${f.durationSeconds ? `${f.durationSeconds}s` : 'still'} | ${mb(f.bytes)} | ${c.url} | ${c.capturedAt.slice(0, 10)} | ${cell(f.shows)} |`);
		}
	}
	const findings = ['| Campaign | Captured URL | Finding |', '| --- | --- | --- |'];
	for (const c of manifest.campaigns) {
		if (!c.url) continue;
		if (!c.defects.length) findings.push(`| ${c.campaign} | ${c.url} | No defect observed at capture |`);
		for (const d of c.defects) findings.push(`| ${c.campaign} | ${c.url} | ${cell(d)} |`);
	}
	const external = ['| Campaign | Proof URL | Why no capture |', '| --- | --- | --- |'];
	for (const c of skipped) external.push(`| ${c.campaign} | ${c.proofUrl} | Not a three.ws surface; the proof is owned by the partner or GitHub |`);
	return { assets: lines.join('\n'), findings: findings.join('\n'), external: external.join('\n') };
}

function replaceBlock(text, name, body) {
	const start = `<!-- ${name}:start -->`;
	const end = `<!-- ${name}:end -->`;
	const re = new RegExp(`${start}[\\s\\S]*?${end}`);
	if (!re.test(text)) throw new Error(`${path.relative(ROOT, README)} is missing the ${name} markers`);
	return text.replace(re, `${start}\n${body}\n${end}`);
}

async function main() {
	let rows = anchorCampaigns();
	if (ONLY.length) {
		const known = new Set(rows.map((r) => r.campaign_id));
		for (const id of ONLY) if (!known.has(id)) throw new Error(`--only names an unknown anchor campaign: ${id}`);
		rows = rows.filter((r) => ONLY.includes(r.campaign_id));
	}
	// Several campaigns: run each in its own process. A 3D route that takes the
	// renderer (or Playwright's CDP session) down with it must not lose the
	// proof already captured for every other campaign.
	if (rows.length > 1 && !flag('child')) return runIsolated(rows);

	const byId = readManifest();

	mkdirSync(PROOF_DIR, { recursive: true });
	const browser = await chromium.launch({
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
	});
	let failures = 0;
	try {
		for (const row of rows) {
			const url = targetUrl(row.anchor_proof);
			if (!url) {
				byId.set(row.campaign_id, { campaign: row.campaign_id, publishDate: row.publish_date, partner: row.partner, url: null, proofUrl: row.anchor_proof, files: [], defects: [] });
				console.log(`skip ${row.campaign_id}: ${row.anchor_proof} is not a three.ws URL`);
				continue;
			}
			const recipe = RECIPES[row.campaign_id];
			if (!recipe) throw new Error(`${row.campaign_id} has no recipe in RECIPES; add one describing what the proof shows`);
			const started = Date.now();
			try {
				const result = await captureCampaign(browser, row, recipe);
				byId.set(row.campaign_id, result);
				const bytes = result.files.reduce((n, f) => n + f.bytes, 0);
				console.log(`ok   ${row.campaign_id} ${result.files.length} files ${mb(bytes)} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
				for (const d of result.defects) console.log(`     defect: ${d}`);
				if (isGated(result.gatedTerms)) console.log(`     GATED (other token named: ${result.gatedTerms.join(', ')})`);
				else if (result.gatedTerms.length) console.log(`     names approved payment tokens: ${result.gatedTerms.join(', ')}`);
			} catch (err) {
				failures++;
				const prior = byId.get(row.campaign_id);
				byId.set(row.campaign_id, {
					campaign: row.campaign_id,
					publishDate: row.publish_date,
					partner: row.partner,
					url,
					capturedAt: new Date().toISOString(),
					files: prior?.files || [],
					defects: [`capture failed: ${String(err?.message || err).split('\n')[0]}`],
				});
				console.error(`FAIL ${row.campaign_id} ${url}: ${String(err?.message || err).split('\n')[0]}`);
			}
		}
	} finally {
		await browser.close();
	}

	writeOutputs(byId);
	if (failures) process.exit(1);
}

function readManifest() {
	const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { campaigns: [] };
	return new Map(previous.campaigns.map((c) => [c.campaign, c]));
}

function runIsolated(rows) {
	const passthrough = [];
	if (flag('no-video')) passthrough.push('--no-video');
	if (opt('base', null)) passthrough.push('--base', BASE);
	let failures = 0;
	for (const row of rows) {
		if (!targetUrl(row.anchor_proof)) {
			const byId = readManifest();
			byId.set(row.campaign_id, { campaign: row.campaign_id, publishDate: row.publish_date, partner: row.partner, url: null, proofUrl: row.anchor_proof, files: [], defects: [] });
			writeOutputs(byId);
			console.log(`skip ${row.campaign_id}: ${row.anchor_proof} is not a three.ws URL`);
			continue;
		}
		const started = new Date().toISOString();
		const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', '--only', row.campaign_id, ...passthrough], {
			stdio: 'inherit',
			timeout: CHILD_TIMEOUT_MS,
			killSignal: 'SIGKILL',
		});
		if (child.status === 0) continue;
		failures++;
		const byId = readManifest();
		const entry = byId.get(row.campaign_id);
		if (entry && entry.capturedAt >= started) continue;
		const why = child.error?.code === 'ETIMEDOUT' || child.signal
			? `the capture did not finish within ${CHILD_TIMEOUT_MS / 60000} minutes and was stopped`
			: `the capture process exited with code ${child.status}`;
		console.error(`FAIL ${row.campaign_id}: ${why}`);
		byId.set(row.campaign_id, {
			campaign: row.campaign_id,
			publishDate: row.publish_date,
			partner: row.partner,
			url: targetUrl(row.anchor_proof),
			capturedAt: new Date().toISOString(),
			files: entry?.files || [],
			defects: [`capture failed: ${why} (the page hung or crashed the headless renderer)`],
		});
		writeOutputs(byId);
	}
	if (failures) process.exit(1);
}

function writeOutputs(byId) {
	const order = anchorCampaigns().map((r) => r.campaign_id);
	const manifest = {
		generatedBy: 'scripts/capture-campaign-proof.mjs',
		source: 'marketing/growth/campaigns.csv',
		campaigns: order.filter((id) => byId.has(id)).map((id) => {
			const { gatedTerms, ...rest } = byId.get(id);
			return rest;
		}),
	};
	writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, '\t')}\n`);
	if (existsSync(README)) {
		const tables = renderTables(manifest);
		let text = readFileSync(README, 'utf8');
		text = replaceBlock(text, 'assets', tables.assets);
		text = replaceBlock(text, 'findings', tables.findings);
		text = replaceBlock(text, 'external', tables.external);
		writeFileSync(README, text);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

// @ts-check
// Headless driver for the avaturn-seed cron.
// --------------------------------------------
// Avaturn has no server-side "export a GLB" REST endpoint — the export only
// happens inside the editor via the SDK's postMessage protocol. So we boot
// headless chromium, load our /internal/avaturn-forge.html harness pointed at a
// fresh catalog session, let the SDK randomize a body + assets + colors and call
// exportAvatar(), then pull the resulting GLB bytes into Node.
//
// Mirrors the lazy-chromium pattern in render-glb.js so Vercel's NFT trace
// doesn't statically pull the chromium tree into unrelated routes.

import { env } from './env.js';
import { fetchModel } from './fetch-model.js';

const DEFAULT_MAX_GLB_BYTES = 30 * 1024 * 1024;

// Keep in lockstep with @sparticuz/chromium-min in package.json (see render-glb.js).
const DEFAULT_CHROMIUM_PACK =
	'https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar';
const CHROMIUM_PACK = env.CHROMIUM_PACK_URL || DEFAULT_CHROMIUM_PACK;

let _browserPromise = null;
async function getBrowser() {
	if (_browserPromise) return _browserPromise;
	_browserPromise = (async () => {
		const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
			import('puppeteer-core'),
			import('@sparticuz/chromium-min'),
		]);
		const executablePath = await chromium.executablePath(CHROMIUM_PACK);
		return puppeteer.launch({
			// The Avaturn editor renders + exports through WebGL; @sparticuz/chromium
			// ships swiftshader so WebGL works headless. Use its default arg set.
			args: chromium.args,
			defaultViewport: { width: 900, height: 1200, deviceScaleFactor: 1 },
			executablePath,
			headless: chromium.headless,
		});
	})().catch((err) => {
		_browserPromise = null;
		throw err;
	});
	return _browserPromise;
}

/**
 * Pull the exported avatar's GLB bytes. Avaturn's `export_type: 'url'` resolves
 * to an https asset URL; we still pull it through the SSRF-pinned fetcher. A
 * data: URL (older export modes) is decoded inline.
 *
 * @param {string} exportUrl
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function pullGlb(exportUrl, maxBytes) {
	if (exportUrl.startsWith('data:')) {
		const comma = exportUrl.indexOf(',');
		const meta = exportUrl.slice(5, comma);
		const payload = exportUrl.slice(comma + 1);
		const buf = meta.includes(';base64')
			? Buffer.from(payload, 'base64')
			: Buffer.from(decodeURIComponent(payload));
		if (buf.length > maxBytes) throw new Error(`exported glb too large: ${buf.length} bytes`);
		return buf;
	}
	const { bytes } = await fetchModel(exportUrl, { maxBytes });
	return Buffer.from(bytes);
}

/**
 * Drive one full headless Avaturn export. With no `sessionUrl` the harness opens
 * the public demo editor (no API key) — that's the default seed path.
 *
 * @param {{
 *   seed: string,
 *   bodyType?: 'male'|'female',
 *   sessionUrl?: string,
 *   keepBody?: boolean,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 * }} opts
 * @returns {Promise<{ glbBytes: Buffer, exportUrl: string, look: any }>}
 */
export async function exportRandomAvaturnAvatar({
	seed,
	bodyType = 'male',
	sessionUrl,
	keepBody = false,
	timeoutMs = 110_000,
	maxBytes = DEFAULT_MAX_GLB_BYTES,
}) {
	const harness = new URL('/internal/avaturn-forge.html', env.APP_ORIGIN);
	if (sessionUrl) harness.searchParams.set('session', sessionUrl);
	// Photo-session avatars are a reconstructed person — keep that body/face and
	// only vary outfit + colors, never swap to a random catalog body.
	if (keepBody) harness.searchParams.set('keepBody', '1');
	harness.searchParams.set('seed', String(seed));
	harness.searchParams.set('bodyType', bodyType);

	const browser = await getBrowser();
	const page = await browser.newPage();
	try {
		await page.goto(harness.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
		await page.waitForFunction('window.__avaturnDone === true', {
			timeout: timeoutMs,
			polling: 1000,
		});

		const { error, result } = await page.evaluate(() => ({
			error: window.__avaturnError,
			result: window.__avaturnResult,
		}));
		if (error) {
			throw Object.assign(new Error(`avaturn export failed: ${error}`), {
				code: 'export_failed',
			});
		}
		const exportUrl = result?.url;
		if (!exportUrl) {
			throw Object.assign(new Error('avaturn export produced no url'), {
				code: 'export_failed',
			});
		}

		const glbBytes = await pullGlb(exportUrl, maxBytes);
		return { glbBytes, exportUrl, look: result?.look ?? null };
	} finally {
		await page.close().catch(() => {});
	}
}

// Test seam — bypass the real launcher without monkey-patching the module path.
export function __setBrowserForTests(browser) {
	_browserPromise = browser ? Promise.resolve(browser) : null;
}

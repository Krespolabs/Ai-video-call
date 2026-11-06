#!/usr/bin/env node
/**
 * Generic GLB → PNG poster renderer for the asset-ingestion pipelines.
 *
 * Sources that don't ship their own thumbnails (Quaternius, Kenney, most 3D
 * objects) need a poster for the gallery/marketplace cards. This renders each
 * GLB in a headless model-viewer and uploads the PNG to R2.
 *
 * To dodge R2 CORS on non-production origins, each GLB is fetched from R2
 * server-side and served to the harness from a same-origin temp dir.
 *
 * Input: a JSON array on stdin (or --manifest=<file>) of
 *   [{ glbKey: 'objects/quaternius/glb/robot.glb', thumbKey: 'objects/quaternius/thumbs/robot.png' }, …]
 * Skips any thumbKey already present in R2 unless --force.
 *
 * Usage:
 *   echo '[{"glbKey":"…","thumbKey":"…"}]' | node scripts/render-glb-thumbnails.mjs
 *   node scripts/render-glb-thumbnails.mjs --manifest=jobs.json --concurrency=2 --force
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { getObject, putObject, objectExists } from './lib/asset-r2.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(__dirname, 'glb-thumbnail-harness.html');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const FORCE = !!args.force;
const CONCURRENCY = Number(args.concurrency) || 2;

async function readJobs() {
	if (args.manifest) return JSON.parse(readFileSync(args.manifest, 'utf8'));
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	return JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]');
}

(async () => {
	const jobs = await readJobs();
	if (!Array.isArray(jobs) || jobs.length === 0) {
		console.log('No jobs.'); return;
	}

	// Temp dir served same-origin so model-viewer can load GLBs without CORS.
	const scratch = mkdtempSync(join(tmpdir(), 'glb-thumb-'));
	const harnessHtml = readFileSync(HARNESS, 'utf8');

	const server = createServer((req, res) => {
		if (req.url === '/' || req.url === '/harness.html') {
			res.setHeader('content-type', 'text/html'); res.end(harnessHtml); return;
		}
		const path = join(scratch, decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]));
		try {
			const buf = readFileSync(path);
			res.setHeader('content-type', 'model/gltf-binary');
			res.setHeader('access-control-allow-origin', '*');
			res.end(buf);
		} catch { res.statusCode = 404; res.end('not found'); }
	});
	await new Promise((r) => server.listen(0, r));
	const port = server.address().port;

	const { chromium } = await import('playwright');
	const launch = () => chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
	let browser = await launch();
	let relaunching = null;

	let ok = 0, fail = 0, skipped = 0, cursor = 0;

	// A heavy model can crash the renderer process. One page reused for the whole
	// run meant a single crash failed every job after it (389 of 511 on one run),
	// so a worker can always get a fresh page, and a fresh browser if that died too.
	async function relaunch() {
		relaunching ||= (async () => {
			await browser.close().catch(() => {});
			browser = await launch();
			relaunching = null;
		})();
		await relaunching;
	}
	// Opening a page can crash too when the machine is short of memory, so that is
	// retried against a fresh browser, with a pause that lets memory come back.
	async function openPage() {
		for (let attempt = 1; ; attempt++) {
			try {
				if (!browser.isConnected()) await relaunch();
				const page = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 2 });
				page.on('pageerror', () => {});
				await page.goto(`http://localhost:${port}/harness.html`, { waitUntil: 'domcontentloaded' });
				await page.waitForFunction('window.__ready === true', { timeout: 20000 });
				return page;
			} catch (err) {
				if (attempt >= 5) throw err;
				await new Promise((r) => setTimeout(r, 4000 * attempt));
				await relaunch();
			}
		}
	}
	const crashed = (err) => /Target crashed|Target page, context or browser has been closed|Browser has been closed|Protocol error/i.test(err.message);

	async function worker(wi) {
		let page = await openPage();

		while (cursor < jobs.length) {
			const i = cursor++;
			const { glbKey, thumbKey } = jobs[i];
			const label = `[${i + 1}/${jobs.length}]`;
			try {
				if (!FORCE && await objectExists(thumbKey)) { skipped++; continue; }
				const glb = await getObject(glbKey);
				const local = `m${wi}-${i}.glb`;
				writeFileSync(join(scratch, local), glb);
				let dataUrl;
				try {
					dataUrl = await page.evaluate((u) => window.__renderGlb(u), `http://localhost:${port}/${local}`);
				} catch (err) {
					if (!crashed(err)) throw err;
					// One more try on a clean page: a crash is often the machine, not the model.
					await page.close().catch(() => {});
					page = await openPage();
					dataUrl = await page.evaluate((u) => window.__renderGlb(u), `http://localhost:${port}/${local}`);
				} finally {
					rmSync(join(scratch, local), { force: true });
				}
				const png = Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
				if (png.length < 1000) throw new Error('empty render');
				// A blank frame is a perfectly valid PNG of a respectable size, so size alone
				// let empty posters through. A frame with no variation in any channel,
				// alpha included, has nothing drawn in it.
				const { channels } = await sharp(png).stats();
				if (Math.max(...channels.map((ch) => ch.stdev)) < 2) throw new Error('blank render: nothing was drawn');
				await putObject(thumbKey, png, 'image/png', 'public, max-age=604800');
				ok++;
				if (ok % 20 === 0) process.stdout.write(`\r  ${ok} rendered, ${skipped} skipped, ${fail} failed…`);
			} catch (err) {
				fail++;
				console.warn(`${label} render fail ${glbKey}: ${err.message.split('\n')[0]}`);
				// The retry crashed as well: leave this model and carry on with a live page.
				if (crashed(err)) { await page.close().catch(() => {}); page = await openPage(); }
			}
		}
		await page.close().catch(() => {});
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
	await browser.close();
	server.close();
	rmSync(scratch, { recursive: true, force: true });
	console.log(`\nThumbnails: ${ok} rendered, ${skipped} skipped, ${fail} failed.`);
})().catch((err) => { console.error(err); process.exit(1); });

#!/usr/bin/env node
/**
 * pump-launch-server — local control panel for the repo→coin launcher.
 *
 *   npm run pump:launch:ui      (or: node scripts/pump-launch-server.mjs)
 *
 * Serves a single-page UI on http://localhost:4599 and a small JSON/SSE API
 * backed by scripts/lib/pump-launch-core.mjs. Runs on localhost only — the
 * private keys it generates never leave your machine and are never exposed on a
 * public route. Nothing is sent on-chain until you click Launch with a funded
 * master wallet.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';

import {
	makeConfig,
	resolveGithubUser,
	fetchRepos,
	generate,
	loadState,
	loadJson,
	runLaunch,
	verifyOwnership,
	estimateCost,
	masterPubkey,
	masterBalanceLamports,
	sol,
	ROOT,
} from './lib/pump-launch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_FILE = join(HERE, 'pump-launch-ui', 'index.html');
const PORT = Number(process.env.PORT || argFlag('port') || 4599);

function argFlag(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : null;
}

// A tiny in-memory cache so the id lookup isn't repeated on every call.
const idCache = new Map();
function resolveUser(user) {
	if (idCache.has(user)) return idCache.get(user);
	const profile = resolveGithubUser(user);
	idCache.set(user, profile);
	return profile;
}

// Build a config from a username (+ optional overrides), resolving the id.
function cfgFor(params = {}) {
	const user = params.user || 'nirholas';
	const profile = resolveUser(user);
	return makeConfig({
		network: params.network,
		rpcUrl: params.rpc,
		githubUser: user,
		githubId: profile.id,
		devBuySol: params.devBuy != null ? Number(params.devBuy) : 0,
		fundPerWalletSol: params.fundPerWallet != null ? Number(params.fundPerWallet) : undefined,
		includeForks: params.forks !== 'false' && params.forks !== false,
		includeArchived: params.archived !== 'false' && params.archived !== false,
	});
}

// ── cover-image proxy (cache + dedupe + avatar fallback) ─────────────────────
// GitHub's OpenGraph endpoint 429s when 146 covers load at once. Fetch through
// here so each (user,repo) resolves once, is cached, and falls back to the
// user's avatar rather than a broken image.
const coverCache = new Map();
const coverInflight = new Map();
async function coverImage(user, repo) {
	const key = `${user}/${repo}`;
	if (coverCache.has(key)) return coverCache.get(key);
	if (coverInflight.has(key)) return coverInflight.get(key);
	const job = (async () => {
		for (const url of [
			`https://opengraph.githubassets.com/1/${user}/${repo}`,
			`https://avatars.githubusercontent.com/${user}?s=400`,
		]) {
			try {
				const r = await fetch(url);
				if (r.ok) {
					const buf = Buffer.from(await r.arrayBuffer());
					coverCache.set(key, buf);
					return buf;
				}
			} catch {
				/* next */
			}
		}
		// 1x1 transparent PNG fallback so the <img> never shows a broken icon.
		const fallback = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
			'base64',
		);
		coverCache.set(key, fallback);
		return fallback;
	})();
	coverInflight.set(key, job);
	const out = await job;
	coverInflight.delete(key);
	return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function sendJson(res, code, data) {
	const body = JSON.stringify(data);
	res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	res.end(body);
}
function readBody(req) {
	return new Promise((resolve) => {
		let data = '';
		req.on('data', (c) => (data += c));
		req.on('end', () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				resolve({});
			}
		});
	});
}

// ── routes ───────────────────────────────────────────────────────────────────
async function handle(req, res) {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const p = url.pathname;
	const q = Object.fromEntries(url.searchParams);

	try {
		if (p === '/' || p === '/index.html') {
			const html = await readFile(UI_FILE, 'utf8');
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			return res.end(html);
		}

		if (p === '/api/resolve') {
			const profile = resolveUser(q.user || 'nirholas');
			return sendJson(res, 200, profile);
		}

		if (p === '/api/repos') {
			const cfg = cfgFor(q);
			const repos = fetchRepos(cfg);
			return sendJson(res, 200, {
				user: cfg.githubUser,
				githubId: cfg.githubId,
				socialFeePda: cfg.socialPda,
				count: repos.length,
				repos,
			});
		}

		if (p === '/api/state') {
			const cfg = cfgFor(q);
			const { manifest, rows } = loadState(cfg);
			const balance = await masterBalanceLamports(cfg);
			const own = verifyOwnership(cfg);
			const count = manifest?.repo_count || Number(q.count || 0);
			return sendJson(res, 200, {
				network: cfg.network,
				master: masterPubkey(cfg),
				masterBalanceSol: +sol(balance).toFixed(6),
				socialFeePda: cfg.socialPda,
				manifest,
				rows,
				ownership: own,
				cost: estimateCost(cfg, count),
				zipReady: existsSync(cfg.zipPath),
			});
		}

		if (p === '/api/cover') {
			const png = await coverImage(q.user || 'nirholas', q.repo || '');
			res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public,max-age=86400' });
			return res.end(png);
		}

		if (p === '/api/qr') {
			const png = await QRCode.toBuffer(q.text || '', { width: 320, margin: 1, color: { dark: '#0a0a0f', light: '#ffffff' } });
			res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600' });
			return res.end(png);
		}

		if (p === '/api/generate' && req.method === 'POST') {
			const body = await readBody(req);
			const cfg = cfgFor(body);
			const selected = Array.isArray(body.repos) ? body.repos : [];
			if (!selected.length) return sendJson(res, 400, { error: 'no repos selected' });
			const manifest = generate(cfg, selected);
			return sendJson(res, 200, {
				ok: true,
				master: manifest.master_pubkey,
				count: manifest.repo_count,
				cost: estimateCost(cfg, manifest.repo_count),
				socialFeePda: cfg.socialPda,
			});
		}

		if (p === '/api/download') {
			const cfg = cfgFor(q);
			if (!existsSync(cfg.zipPath)) return sendJson(res, 404, { error: 'no bundle — generate first' });
			const size = statSync(cfg.zipPath).size;
			res.writeHead(200, {
				'content-type': 'application/zip',
				'content-length': size,
				'content-disposition': 'attachment; filename="pump-launch-wallets.zip"',
			});
			return createReadStream(cfg.zipPath).pipe(res);
		}

		if (p === '/api/launch' && req.method === 'POST') {
			const body = await readBody(req);
			const cfg = cfgFor(body);
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive',
			});
			const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
			const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
			try {
				await runLaunch(cfg, { repoNames: body.repoNames || null, onEvent: send });
			} catch (e) {
				send({ type: 'fatal', message: e.message });
			} finally {
				clearInterval(heartbeat);
				res.end();
			}
			return;
		}

		sendJson(res, 404, { error: 'not found' });
	} catch (e) {
		sendJson(res, 500, { error: e.message });
	}
}

const server = http.createServer(handle);
server.listen(PORT, () => {
	const line = '─'.repeat(54);
	console.log(`\n  ${line}`);
	console.log(`   pump.fun repo→coin launcher — control panel`);
	console.log(`   ▶  http://localhost:${PORT}`);
	console.log(`   keys stay local · nothing sent until you click Launch`);
	console.log(`  ${line}\n`);
});

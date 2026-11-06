// Local dev server for the Granite Proof page (/ibm/proof).
//
// In normal `npm run dev`, /api/* proxies to production, so a brand-new endpoint
// like /api/ibm/attest isn't reachable until it ships. This tiny single-origin
// server serves the page, its module, AND the real /api/ibm/attest handler so
// you can exercise the whole feature locally against live GeckoTerminal data
// (and, with WATSONX_* + AVATAR_WALLET_SECRET set, real Granite + on-chain
// notarization). Every other asset (brand.js, avatar-embed, GLBs) redirects to
// production.
//
//   node scripts/dev-ibm-proof.mjs            # → http://localhost:3014/ibm/proof
//   PORT=4000 node scripts/dev-ibm-proof.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import attest from '../api/ibm/attest.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3014);
const PROD = 'https://three.ws';

const FILES = {
	'/ibm/proof': ['pages/ibm/proof.html', 'text/html; charset=utf-8'],
	'/ibm/proof/': ['pages/ibm/proof.html', 'text/html; charset=utf-8'],
	'/': ['pages/ibm/proof.html', 'text/html; charset=utf-8'],
	'/src/ibm-proof.js': ['src/ibm-proof.js', 'text/javascript; charset=utf-8'],
};

const server = createServer(async (req, res) => {
	const path = (req.url || '/').split('?')[0];

	if (path.startsWith('/api/ibm/attest')) {
		try {
			await attest(req, res);
		} catch (e) {
			res.statusCode = 500;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ error: 'handler_threw', message: String(e?.message || e) }));
		}
		return;
	}

	const file = FILES[path];
	if (file) {
		try {
			const body = await readFile(resolve(ROOT, file[0]));
			res.statusCode = 200;
			res.setHeader('content-type', file[1]);
			res.end(body);
		} catch (e) {
			res.statusCode = 404;
			res.end('not found: ' + file[0]);
		}
		return;
	}

	// Everything else (brand.js, /avatar-embed.html, /avatars/*.glb, favicon)
	// comes from production so the page renders complete.
	res.statusCode = 302;
	res.setHeader('Location', PROD + req.url);
	res.end();
});

server.listen(PORT, () => {
	console.log(`Granite Proof dev server → http://localhost:${PORT}/ibm/proof`);
	console.log(`  /api/ibm/attest served locally; other assets proxy to ${PROD}`);
});

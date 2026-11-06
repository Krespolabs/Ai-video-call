// /api/zauth-reposcan — same-origin pass-through to zauth's paid RepoScan
// x402 endpoint (https://api.zauth.inc/x402/reposcan, $0.05 USDC on Base or
// Solana).
//
// The zauth security agent in the $THREE town (/play) sells repo scans from
// this route. The browser cannot pay zauth directly: their CORS policy does
// not allow any payment request header and does not expose the
// payment-required response header, so both legs of the x402 handshake die
// cross-origin. This route forwards the request and re-emits the response so
// window.X402.pay can run the full flow same-origin. The player signs with
// their OWN wallet, the USDC transfer goes straight to zauth's payTo
// address, and zauth's facilitator settles it; no platform key touches the
// payment and no funds pass through this server.
//
// Wire-format notes (verified with a real settled payment, 2026-06-12):
//   • zauth reads the payment envelope from the `payment-signature` header —
//     an envelope sent as X-PAYMENT is ignored and re-402'd. Our modal sends
//     X-PAYMENT, so the proxy translates the header name.
//   • zauth's verifier wants the envelope shaped {x402Version, payload,
//     resource, accepted} with resource.url = THEIR endpoint URL. The modal
//     builds resource.url from the same-origin route it called, so the proxy
//     normalizes the envelope and rewrites resource.url before forwarding.
//   • Upstream's input field is `repoUrl` (full GitHub URL), validated only
//     AFTER the payment middleware. The public surface here takes
//     { repo: "owner/repo" } and expands it, so a malformed repo can never
//     burn a payment on a post-settle 400.
//
//   POST /api/zauth-reposcan            { repo: "owner/repo" } (+ X-PAYMENT)
//     → POST https://api.zauth.inc/x402/reposcan   { repoUrl } (+ payment-signature)
//     paid 200 → { status: "scanning", scanId, sessionToken }
//   GET  /api/zauth-reposcan?session=…  free progress poll for a paid scan
//     → GET  https://api.zauth.inc/x402/reposcan/:session
//     200 → { status: "scanning" } … { status: "completed", zauthScore, analysisMarkdown }

import { cors, error, method, rateLimited, readJson, wrap } from './_lib/http.js';
import { clientIp, limits } from './_lib/rate-limit.js';

const UPSTREAM = 'https://api.zauth.inc/x402/reposcan';

// owner/repo — GitHub's own constraint set, tight enough to keep the proxy
// from forwarding arbitrary strings upstream.
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const SESSION_RE = /^[A-Za-z0-9._-]{8,1024}$/;

// Response headers the x402 modal needs to read: the 402 challenge and (if
// upstream ever adds one) the settlement receipt. Same-origin, so no
// expose-headers dance is required.
const PASS_HEADERS = ['payment-required', 'x-payment-response', 'content-type'];

function passThrough(res, upstream, bodyText) {
	res.statusCode = upstream.status;
	for (const name of PASS_HEADERS) {
		const value = upstream.headers.get(name);
		if (value) res.setHeader(name, value);
	}
	if (!upstream.headers.get('content-type')) {
		res.setHeader('content-type', 'application/json; charset=utf-8');
	}
	res.end(bodyText);
}

// Normalize a payment envelope from our modal into the shape zauth's
// facilitator verifies: official-client field set only, resource.url
// rewritten to the upstream URL. The envelope is metadata around the signed
// transfer — the signature itself (Solana tx / EIP-3009 typed data) is
// untouched, so this cannot redirect funds, only make the wrapper legible.
export function normalizeEnvelope(headerValue) {
	let envelope;
	try {
		envelope = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
	} catch {
		return headerValue; // not base64-JSON — forward untouched
	}
	if (!envelope || typeof envelope !== 'object' || !envelope.payload) return headerValue;
	const normalized = {
		x402Version: envelope.x402Version || 2,
		payload: envelope.payload,
		resource: {
			url: UPSTREAM,
			mimeType: envelope.resource?.mimeType || 'application/json',
		},
		...(envelope.accepted ? { accepted: envelope.accepted } : {}),
	};
	return Buffer.from(JSON.stringify(normalized)).toString('base64');
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.zauthScanIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://x');
		const session = url.searchParams.get('session') || '';
		if (!SESSION_RE.test(session)) {
			return error(res, 400, 'invalid_session', 'session must be a token from a paid scan');
		}
		const upstream = await fetch(`${UPSTREAM}/${encodeURIComponent(session)}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(25_000),
		});
		return passThrough(res, upstream, await upstream.text());
	}

	const body = await readJson(req);
	const repo = typeof body?.repo === 'string' ? body.repo.trim() : '';
	if (!REPO_RE.test(repo)) {
		return error(res, 400, 'invalid_repo', 'repo must look like "owner/repo"');
	}

	const headers = { 'content-type': 'application/json', accept: 'application/json' };
	const payment = req.headers['x-payment'] || req.headers['payment-signature'];
	if (typeof payment === 'string' && payment) {
		headers['payment-signature'] = normalizeEnvelope(payment);
	}
	// zauth offers free access to ZAUTH holders via a sign-in-with-x wallet
	// signature (advertised in their 402 challenge); pass that leg through too.
	const siwx = req.headers['sign-in-with-x'];
	if (typeof siwx === 'string' && siwx) headers['sign-in-with-x'] = siwx;

	const upstream = await fetch(UPSTREAM, {
		method: 'POST',
		headers,
		body: JSON.stringify({ repoUrl: `https://github.com/${repo}` }),
		// Paid calls block on on-chain settlement; give them most of the
		// function budget. Unpaid probes return the 402 immediately.
		signal: AbortSignal.timeout(payment ? 55_000 : 15_000),
	});
	return passThrough(res, upstream, await upstream.text());
});

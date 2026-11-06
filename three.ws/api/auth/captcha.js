// CAPTCHA challenge/verify endpoint for login rate-limit relief.
// Uses Altcha (proof-of-work, no tracking, MIT-licensed) so rate-limited humans
// can solve a short CPU puzzle instead of waiting out the full cooldown.
//
// GET  /api/auth/captcha  → returns an Altcha challenge JSON
// POST /api/auth/captcha  → verifies solution, returns a signed bypass token
//
// The bypass token is HMAC-signed (ip + time-window), stateless, valid 10 minutes.
// The login handler checks it and uses a dedicated, separate rate-limit bucket
// (authIpCaptcha) instead of the normal authIp bucket, so solving one puzzle
// opens a fresh set of attempts without resetting the anti-abuse counter.

import { createChallenge, verifySolution } from 'altcha-lib/v1';
import { createHmac } from 'node:crypto';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';

// ALTCHA_HMAC_KEY is the shared secret for challenge signing.
// Falls back to JWT_SECRET (always present) with a domain suffix so
// the two secrets never collide — no new env var required to deploy.
function captchaSecret() {
	return process.env.ALTCHA_HMAC_KEY || (env.JWT_SECRET + ':altcha');
}

// Bypass token: `v1:{timeWindow}:{hmac}` where timeWindow = floor(epoch_ms / 600_000)
// Stateless, per-IP, valid for the current and previous 10-minute window (~20 min max).
const TOKEN_WINDOW_MS = 600_000; // 10 minutes

function issueBypassToken(ip) {
	const secret = captchaSecret();
	const window = Math.floor(Date.now() / TOKEN_WINDOW_MS);
	const sig = createHmac('sha256', secret).update(`${ip}:${window}`).digest('hex');
	return `v1:${window}:${sig}`;
}

export function verifyBypassToken(ip, token) {
	if (!token || typeof token !== 'string') return false;
	const parts = token.split(':');
	if (parts.length !== 3 || parts[0] !== 'v1') return false;
	const tokenWindow = parseInt(parts[1], 10);
	if (!Number.isFinite(tokenWindow)) return false;
	const currentWindow = Math.floor(Date.now() / TOKEN_WINDOW_MS);
	// Accept current window and the previous one (up to ~20 min total).
	if (tokenWindow !== currentWindow && tokenWindow !== currentWindow - 1) return false;
	const secret = captchaSecret();
	const expected = createHmac('sha256', secret).update(`${ip}:${tokenWindow}`).digest('hex');
	// Constant-time comparison to prevent timing attacks.
	if (expected.length !== parts[2].length) return false;
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
	}
	return mismatch === 0;
}

async function handleGet(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	// maxNumber controls puzzle difficulty. 50_000 = ~0.5–2 s solve time on a
	// typical device. Low enough to never frustrate a real user, high enough to
	// be genuinely annoying for a bot making thousands of attempts.
	const challenge = await createChallenge({
		hmacKey: captchaSecret(),
		maxNumber: 50_000,
	});
	return json(res, 200, challenge);
}

async function handlePost(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const body = await readJson(req).catch(() => null);
	if (!body?.payload) return error(res, 400, 'bad_request', 'payload required');
	const ip = clientIp(req);
	let ok = false;
	try {
		ok = await verifySolution(body.payload, captchaSecret());
	} catch {
		return error(res, 400, 'bad_request', 'invalid payload');
	}
	if (!ok) return error(res, 400, 'captcha_failed', 'captcha verification failed');
	const token = issueBypassToken(ip);
	return json(res, 200, { ok: true, token });
}

export default wrap(async (req, res) => {
	if (req.method === 'GET') return handleGet(req, res);
	return handlePost(req, res);
});

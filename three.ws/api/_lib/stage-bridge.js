// Living Stages — the Vercel half of the bridge to the standalone Colyseus server.
//
// Two directions, both HMAC-signed with the shared multiplayer secret bound to
// the exact body + a fresh timestamp (same discipline as presence-store.js'
// /internal/notify), so a captured tuple can't be replayed with attacker-chosen
// content or after the freshness window:
//
//   API → server  notifyStageRoom(): the instant a tip settles + is recorded, push
//                 it to the live StageRoom over /internal/stage so the host reacts
//                 in ~1s. Best-effort: the money already settled on-chain, so a
//                 missed push only loses the in-room flourish, never funds.
//
//   server → API  verifyStageRequest(): the room's host loop fetches its next beat
//                 from /api/stage/host; this verifies that call really came from
//                 the multiplayer server (not a public caller draining the brain).
//
// Keep byte-compatible with multiplayer/src/presence-token.js (verifyStageSignature
// / signStageRequest).

import { env } from './env.js';
import { hmacSha256, sha256Base64Url, constantTimeEquals } from './crypto.js';

const STAGE_MAX_AGE_S = 120;

// Push a stage event (today: a settled tip) to the live room. Returns
// { delivered, reason } and never throws into the request path.
export async function notifyStageRoom(stageId, event, payload = {}) {
	const base = env.MULTIPLAYER_INTERNAL_URL;
	if (!base) return { delivered: false, reason: 'unconfigured' };
	const body = { stageId, event, ...payload };
	try {
		const ts = Math.floor(Date.now() / 1000);
		const payloadHash = await sha256Base64Url(JSON.stringify(body ?? {}));
		const sig = await hmacSha256(env.MULTIPLAYER_SHARED_SECRET, `stage:${ts}:${payloadHash}`);
		const res = await fetch(`${base}/internal/stage`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-stage-signature': sig,
				'x-stage-timestamp': String(ts),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return { delivered: false, reason: `http_${res.status}` };
		const out = await res.json().catch(() => ({}));
		return { delivered: !!out?.delivered, reason: out?.reason };
	} catch (err) {
		return { delivered: false, reason: err?.name === 'TimeoutError' ? 'timeout' : 'error' };
	}
}

// Verify an inbound room → API request (the host loop fetching the next beat).
// `body` is the parsed JSON the handler will act on; recompute the hash over the
// same bytes the server signed. Returns true iff the signature + freshness check
// pass. Mirrors signStageRequest in multiplayer/src/presence-token.js.
export async function verifyStageRequest(req, body) {
	try {
		const sig = req.headers['x-stage-sig'] || req.headers['X-Stage-Sig'];
		const ts = req.headers['x-stage-ts'] || req.headers['X-Stage-Ts'];
		if (typeof sig !== 'string' || !sig) return false;
		const tsNum = Number(ts);
		if (!Number.isFinite(tsNum)) return false;
		const nowS = Math.floor(Date.now() / 1000);
		if (Math.abs(nowS - tsNum) > STAGE_MAX_AGE_S) return false;
		const payloadHash = await sha256Base64Url(JSON.stringify(body ?? {}));
		const expected = await hmacSha256(env.MULTIPLAYER_SHARED_SECRET, `stage-req:${tsNum}:${payloadHash}`);
		return constantTimeEquals(sig, expected);
	} catch {
		// A missing/empty shared secret (hmac throws) or any verification error is a
		// hard "no" — never let it surface as a 500 on a forged request.
		return false;
	}
}

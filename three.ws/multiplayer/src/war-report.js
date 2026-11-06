// War result reporting — the game-server → API bridge for Coin Wars. When a clash
// ends, ClashRoom calls reportBattle() to persist the result into the war ledger the
// /wars standings are computed from. The POST is HMAC-signed with a shared secret so
// only this trusted game process can write battle outcomes — a client (or anyone who
// found the endpoint) can't forge a win for their community. Mirrors the trust model
// of holder-pass.js, in the other direction.

import crypto from 'node:crypto';

const DEV_SECRET = 'three-ws-war-report-dev-secret';

function secret() {
	const s = process.env.WAR_RESULT_SECRET || process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	if (process.env.NODE_ENV === 'production') {
		throw new Error('[war-report] WAR_RESULT_SECRET is required in production — refusing to sign with the dev secret.');
	}
	return DEV_SECRET;
}

// Where the three.ws API lives. Defaults to production; override for local/staging.
function apiBase() {
	return (process.env.THREE_WS_API_BASE || 'https://three.ws').replace(/\/$/, '');
}

export function signBattle(bodyString) {
	return crypto.createHmac('sha256', secret()).update(bodyString).digest('hex');
}

// Persist one finished battle. `battle` is the shape ClashMatch.result() produces,
// enriched by the room with the matchKey + network. Returns true on a 2xx, false on
// any failure — the caller logs but never throws, so a flaky API never crashes the
// arena or blocks the next match. Best-effort by design: the live result is already
// broadcast to players; the ledger write is for the league standings.
export async function reportBattle(battle) {
	let bodyString;
	try {
		bodyString = JSON.stringify({ battle });
	} catch {
		return false;
	}
	const url = `${apiBase()}/api/wars?action=report`;
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-war-signature': signBattle(bodyString),
			},
			body: bodyString,
			// Don't let a hung API wedge the arena's match-end path.
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) {
			console.warn(`[war-report] ${url} → ${res.status}`);
			return false;
		}
		return true;
	} catch (err) {
		console.warn('[war-report] failed to post battle result:', err?.message || err);
		return false;
	}
}

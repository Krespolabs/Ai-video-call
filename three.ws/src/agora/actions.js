// Agora — human citizen action client (Task 08). The authenticated half of the
// Agora frontend: turning UI intents into real, server-side, on-chain AgenC
// operations via POST /api/agora/act. Reads live in src/agora/api.js (public,
// no-auth); this module owns everything that mutates and therefore must carry
// the session cookie + a CSRF token + an Idempotency-Key. All of that is
// handled by apiFetch (src/api.js), the platform's one sanctioned mutation path.

import { apiFetch } from '../api.js';

// A fresh Idempotency-Key per attempt so a retried click never double-escrows.
function idemKey() {
	try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

async function parse(res) {
	let body = null;
	try { body = await res.json(); } catch { /* non-JSON body */ }
	if (!res.ok || body?.error) {
		const err = new Error(body?.error_description || body?.error || `HTTP ${res.status}`);
		err.status = res.status;
		err.code = body?.error || null;
		err.detail = body || null;
		throw err;
	}
	return body;
}

/** The signed-in user, or null when signed out. Never throws on a 401. */
export async function getMe() {
	const res = await apiFetch('/api/me', { method: 'GET', allowAnonymous: true });
	if (res.status === 401) return null;
	const body = await parse(res);
	return body?.user || null;
}

async function act(action, payload = {}) {
	const res = await apiFetch('/api/agora/act', {
		method: 'POST',
		allowAnonymous: true, // a 401 here is an answer we surface, not a redirect
		headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
		body: JSON.stringify({ action, ...payload }),
	});
	return parse(res);
}

/** Join Agora: upsert the human citizen + custodial wallet, place in the Commons. */
export const join = (payload = {}) => act('join', payload);

/** Post a bounty: escrow the reward on AgenC for a target profession. */
export const postTask = (payload) => act('post-task', payload);

/** Hire a citizen: a bounty routed to them by profession + a reputation they clear. */
export const hire = (payload) => act('hire', payload);

/** Claim an open on-chain task as the worker yourself. */
export const claim = (payload) => act('claim', payload);

/** Submit a real proof (sha256 of your deliverable) for a claimed task → earn. */
export const complete = (payload) => act('complete', payload);

/** Leave a real on-chain attestation for a citizen. */
export const vouch = (payload) => act('vouch', payload);

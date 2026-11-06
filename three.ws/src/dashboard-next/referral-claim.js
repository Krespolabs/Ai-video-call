// dashboard-next — replay a captured referral once the user is signed in.
//
// public/referral-capture.js parks an inbound `?ref=CODE` in localStorage at
// the auth door. This module replays it against /api/users/referral-claim the
// first time the user reaches any authenticated dashboard page, then clears it
// so it never fires twice. Fire-and-forget: a failed claim never blocks the UI.

import { post } from './api.js';

const KEY = 'tw:ref';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readPending() {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed?.code) return null;
		if (!parsed.ts || Date.now() - parsed.ts > MAX_AGE_MS) {
			localStorage.removeItem(KEY);
			return null;
		}
		return parsed.code;
	} catch {
		return null;
	}
}

function clearPending() {
	try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Attempt to attribute a captured referral. Resolves to the claim status
 * string ('claimed' | 'already' | 'invalid' | 'expired') or null when there
 * was nothing to claim. Safe to call on every page load — it no-ops without a
 * pending code and clears the code on any definitive outcome.
 *
 * @returns {Promise<string|null>}
 */
export async function claimPendingReferral() {
	const code = readPending();
	if (!code) return null;
	try {
		const res = await post('/api/users/referral-claim', { code });
		// Any definitive server outcome means we should stop retrying.
		clearPending();
		return res?.status || null;
	} catch (err) {
		// 401 = not signed in yet (page hadn't gated). Leave the code in place so
		// a later, authenticated load can retry. Any other error is terminal.
		if (err?.status && err.status !== 401) clearPending();
		return null;
	}
}

// $THREE client access SDK — the single module every gated surface imports.
//
// It is the browser's view of the hold-to-access lever: it wraps the two server
// reads that decide entitlement, owns their caching + invalidation, and exposes one
// high-level call that either lets the user through (with a signed tier pass) or
// shows the gate.
//
//   GET  /api/three/access     — the tier + per-feature entitlement matrix (auth
//                                optional; anonymous callers get the Member view).
//   POST /api/three/tier-pass  — mints a short-lived, HMAC-signed pass bound to the
//                                holder's wallet; a gated endpoint trusts it even
//                                when a live RPC read would hiccup.
//
// Public API:
//   • fetchAccess({ feature, fresh })   — the entitlements snapshot (full or single
//                                         feature). Never throws — Member fallback.
//   • getTierPass({ force })            — mint/reuse the bearer pass; null when there
//                                         is none to hold (anonymous / no wallet).
//   • ensureFeatureAccess(feature, …)   — the gate: proceed (with a pass) or open the
//                                         modal and resolve on cancel / recheck.
//   • subscribeAccess(cb) / refreshAccess() — react to wallet/auth/balance changes.
//
// Resilience contract: every network path is caught and degrades to a safe locked /
// anonymous state. Nothing here throws to the caller, and the server stays the only
// authority on eligibility — a pass is a hint, never a grant.

const ACCESS_URL = '/api/three/access';
const TIER_PASS_URL = '/api/three/tier-pass';

// Memoize the full matrix for ~30s; a per-feature read is derived from it when fresh.
const ACCESS_TTL_MS = 30_000;
// Re-mint a pass once it's within 90s of expiry so an in-flight gated request never
// rides a credential that expires mid-handshake.
const PASS_RENEW_BEFORE_MS = 90_000;
// Useful lifetime to assume when a pass payload's `exp` can't be decoded.
const PASS_FALLBACK_TTL_MS = 8 * 60_000;

const hasWindow = typeof window !== 'undefined';

let _matrix = { at: 0, data: null }; // cached full /access snapshot
let _pass = null; // { pass, tier, held_usd, exp(ms) } | null  (memory only — bearer credential)
let _passReason = null; // 'sign_in' | 'link_wallet' | null — why the last mint returned no pass
const _subs = new Set(); // change subscribers

// ── helpers ─────────────────────────────────────────────────────────────────────

// Throwing JSON fetch (mirrors src/three-economy.js). Callers that must never throw
// wrap this; the access/tier-pass endpoints read the session cookie, so include it.
async function getJSON(path, opts = {}) {
	const r = await fetch(path, { credentials: 'include', ...opts });
	if (!r.ok) {
		const body = await r.json().catch(() => ({}));
		const err = new Error(body.error_description || body.error || `${r.status}`);
		err.status = r.status;
		err.code = body.error || null;
		throw err;
	}
	return r.json();
}

// base64url(json) → the pass payload's `exp` (unix seconds) in ms, or 0 if undecodable.
// The pass format is `<b64url(payload)>.<b64url(sig)>`; we only read the payload.
function decodePassExpMs(pass) {
	try {
		let b = String(pass).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
		while (b.length % 4) b += '=';
		const payload = JSON.parse(atob(b));
		const exp = Number(payload.exp) || 0;
		return exp > 0 ? exp * 1000 : 0;
	} catch {
		return 0;
	}
}

// A Member-shaped payload so a caller always has a safe locked state to render after
// a network failure. `_error` flags the degraded read for a richer UI; the shape
// otherwise matches a real signed-out response.
function memberFallback(feature) {
	const tier = { level: 0, id: 'member', label: 'Member', held_usd: 0 };
	const base = { signed_in: false, wallet_linked: false, tier, _error: true };
	if (!feature) return { ...base, features: [] };
	return {
		...base,
		access: {
			feature,
			label: 'Holder feature',
			why: '',
			eligible: false,
			required: null,
			held: { level: 0, id: 'member', label: 'Member', min_usd: 0, usd: 0 },
			reason: 'error',
			pay_per_use: null,
		},
	};
}

// Carve a single-feature payload out of a cached full matrix, so a per-feature read
// is free when the matrix is already warm. Null when the feature isn't in the matrix.
function deriveFeature(matrix, feature) {
	if (!matrix || !Array.isArray(matrix.features)) return null;
	const access = matrix.features.find((f) => f && f.feature === feature);
	if (!access) return null;
	return {
		signed_in: matrix.signed_in,
		wallet_linked: matrix.wallet_linked,
		tier: matrix.tier,
		access,
	};
}

function passIsFresh(entry, now = Date.now()) {
	return Boolean(entry && entry.pass && entry.exp - PASS_RENEW_BEFORE_MS > now);
}

function notify() {
	for (const cb of _subs) {
		try {
			cb();
		} catch {
			/* a subscriber throwing must not break the others */
		}
	}
}

// ── reads ─────────────────────────────────────────────────────────────────────────

/**
 * The entitlements snapshot. With `feature`, returns the single-feature shape
 * ({ ..., access }); without, the full matrix ({ ..., features }). Both always carry
 * { signed_in, wallet_linked, tier }. The full matrix is memoized for ~30s and a
 * per-feature read is served from it when warm. Never throws — returns a
 * Member-shaped fallback (`_error: true`) on any network failure.
 * @param {{ feature?: string, fresh?: boolean }} [opts]
 */
export async function fetchAccess({ feature, fresh = false } = {}) {
	const now = Date.now();
	if (!fresh && _matrix.data && now - _matrix.at < ACCESS_TTL_MS) {
		if (!feature) return _matrix.data;
		const derived = deriveFeature(_matrix.data, feature);
		if (derived) return derived;
	}
	try {
		const url = feature ? `${ACCESS_URL}?feature=${encodeURIComponent(feature)}` : ACCESS_URL;
		const data = await getJSON(url);
		if (!feature && data && Array.isArray(data.features)) _matrix = { at: Date.now(), data };
		return data;
	} catch {
		return memberFallback(feature);
	}
}

/**
 * Mint (or reuse) the signed tier pass a holder attaches to gated calls. Cached in
 * memory only (never localStorage — it is a bearer credential) and re-minted once it
 * is within 90s of expiry. `force` bypasses the cache.
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ pass: string, tier: object|null, held_usd: number|null, exp: number }|null>}
 *   null when the user is signed out (401) / has no linked wallet (403) / the mint
 *   fails. The reason for a null is readable via {@link tierPassReason}.
 */
export async function getTierPass({ force = false } = {}) {
	const now = Date.now();
	if (!force && passIsFresh(_pass, now)) {
		_passReason = null;
		return _pass;
	}
	try {
		const r = await fetch(TIER_PASS_URL, { method: 'POST', credentials: 'include' });
		if (r.status === 201) {
			const data = await r.json().catch(() => null);
			const pass = data && typeof data.pass === 'string' ? data.pass : null;
			if (!pass) {
				_pass = null;
				_passReason = null;
				return null;
			}
			_pass = {
				pass,
				tier: data.tier || null,
				held_usd: data.held_usd ?? null,
				exp: decodePassExpMs(pass) || now + PASS_FALLBACK_TTL_MS,
			};
			_passReason = null;
			return _pass;
		}
		// 401 → sign in; 403 → link a wallet. Either way there is no pass to hold.
		_pass = null;
		_passReason = r.status === 401 ? 'sign_in' : r.status === 403 ? 'link_wallet' : null;
		return null;
	} catch {
		// Transient network error: keep any existing cache for the next attempt, but
		// don't hand back a stale credential this call.
		_passReason = null;
		return null;
	}
}

/** Why the last {@link getTierPass} returned null — 'sign_in' | 'link_wallet' | null. */
export function tierPassReason() {
	return _passReason;
}

// ── the gate ────────────────────────────────────────────────────────────────────

// One attempt at the gate: read the feature's access fresh, and if eligible, mint the
// pass (when the feature needs one). Returns the same shape the modal's recheck expects.
async function attempt(feature, needsPass) {
	const snapshot = await fetchAccess({ feature, fresh: true });
	const access = snapshot && snapshot.access ? snapshot.access : null;
	if (access && access.eligible) {
		if (!needsPass) return { ok: true, pass: null, access, snapshot };
		const pass = await getTierPass();
		// Eligible but the mint hiccupped (transient): fail OPEN — let the server be the
		// final authority rather than trapping a real holder behind a network blip.
		return { ok: true, pass: pass ? pass.pass : null, access, snapshot };
	}
	return { ok: false, reason: (access && access.reason) || 'insufficient_tier', access, snapshot };
}

/**
 * The high-level gate. Resolves { ok:true, pass } when the user may proceed (minting a
 * pass when `needsPass`), or opens the gate modal and resolves { ok:false, reason }
 * when they cancel. If, inside the modal, the user signs in / acquires $THREE and
 * Rechecks into eligibility, it re-resolves { ok:true, pass } and proceeds.
 * @param {string} feature  a gated feature id (e.g. 'forge.high').
 * @param {{ trigger?: Element, needsPass?: boolean }} [opts]  `trigger` is the element
 *   that opened the gate (focus returns to it on close). `needsPass` (default true)
 *   controls whether a pass is minted + returned on success.
 * @returns {Promise<{ ok: true, pass: string|null } | { ok: false, reason: string }>}
 */
export async function ensureFeatureAccess(feature, { trigger, needsPass = true } = {}) {
	const first = await attempt(feature, needsPass);
	if (first.ok) return { ok: true, pass: first.pass };

	let mod;
	try {
		mod = await import('./gate-modal.js');
	} catch {
		// The modal chunk failed to load — fail closed but never throw to the caller.
		return { ok: false, reason: first.reason };
	}
	const outcome = await mod.openGateModal({
		feature,
		trigger,
		snapshot: first.snapshot,
		recheck: () => attempt(feature, needsPass),
	});
	if (outcome && outcome.ok) return { ok: true, pass: outcome.pass ?? null };
	return { ok: false, reason: (outcome && outcome.reason) || first.reason || 'cancelled' };
}

// ── change notification ───────────────────────────────────────────────────────────

/**
 * Subscribe to access changes (wallet connect/disconnect, sign-in, manual refresh).
 * @param {() => void} cb
 * @returns {() => void} unsubscribe
 */
export function subscribeAccess(cb) {
	if (typeof cb !== 'function') return () => {};
	_subs.add(cb);
	return () => _subs.delete(cb);
}

/**
 * Drop the cached snapshot + pass and notify subscribers. Call after a known balance
 * or auth change so the next read re-resolves against the server.
 */
export function refreshAccess() {
	_matrix = { at: 0, data: null };
	_pass = null;
	_passReason = null;
	notify();
}

// A wallet connect/disconnect changes who the caller is, so every cached answer is now
// for the wrong identity. Drop them and notify — the one live coupling, kept light.
if (hasWindow && typeof window.addEventListener === 'function') {
	window.addEventListener('wallet:changed', refreshAccess);
}

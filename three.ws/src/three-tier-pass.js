// $THREE tier-pass helper — the tiny, dependency-free seam every gated surface
// uses to (a) read the caller's hold-to-access tier and (b) carry a portable,
// RPC-free proof of holder tier on a gated request.
//
// Two server reads back it:
//   • GET  /api/three/access?feature=…  — the tier + per-feature entitlement matrix
//     (auth optional; anonymous callers get the Member view so a page can render a
//     locked state without forcing sign-in).
//   • POST /api/three/tier-pass         — mints a short-lived (10 min) HMAC-signed
//     pass bound to the holder's wallet. A gated endpoint trusts the pass even when
//     a live RPC read would hiccup, so a holder is never locked out by an outage.
//
// The pass is cached in memory AND sessionStorage so it survives in-tab navigation
// without re-minting, and is treated as stale ~2 min before the server expiry
// (≈ 8 min of useful life) so a request never rides a pass that expires mid-flight.
//
// Resilience contract: every network path is try/caught and degrades gracefully —
// getTierPass() → null, getAccess() → a Member-shaped fallback. Nothing here ever
// throws to the caller, and the server stays the only authority on eligibility.

const ACCESS_URL = '/api/three/access';
const TIER_PASS_URL = '/api/three/tier-pass';
const PASS_STORE_KEY = 'three_tier_pass';

// Passes live 10 min server-side; re-mint ~2 min early so an in-flight gated
// request never carries an about-to-expire pass.
const PASS_STALE_BEFORE_EXP_MS = 2 * 60 * 1000;
// Fallback lifetime when the pass payload's exp can't be decoded (~8 min useful).
const PASS_FALLBACK_TTL_MS = 8 * 60 * 1000;

// In-memory cache: { pass: string, exp: number(ms) } or null.
let _cache = null;

// ── helpers ─────────────────────────────────────────────────────────────────

const hasWindow = typeof window !== 'undefined';

// base64url → JSON. The tier pass is `<payload>.<sig>`; the payload carries `exp`
// in unix seconds. Returns the expiry in ms, or 0 when it can't be decoded.
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

function isFresh(entry) {
	return Boolean(entry && entry.pass && entry.exp - PASS_STALE_BEFORE_EXP_MS > Date.now());
}

// sessionStorage access can throw (private mode, disabled storage) — never let it.
function readStored() {
	if (!hasWindow) return null;
	try {
		const raw = window.sessionStorage.getItem(PASS_STORE_KEY);
		if (!raw) return null;
		const entry = JSON.parse(raw);
		if (entry && typeof entry.pass === 'string' && Number.isFinite(entry.exp)) return entry;
		return null;
	} catch {
		return null;
	}
}

function writeStored(entry) {
	if (!hasWindow) return;
	try {
		window.sessionStorage.setItem(PASS_STORE_KEY, JSON.stringify(entry));
	} catch {
		/* storage full / unavailable — the in-memory cache still serves this tab */
	}
}

function dropStored() {
	if (!hasWindow) return;
	try {
		window.sessionStorage.removeItem(PASS_STORE_KEY);
	} catch {
		/* ignore */
	}
}

// A Member-shaped access payload so a caller can always render a safe locked state
// after a network failure. `_error` flags the degraded read so a richer UI (the
// <three-gate> element) can show "couldn't check — retry" instead of a wrong lock.
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

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Mint (or reuse) the signed $THREE tier pass for the current caller.
 * @returns {Promise<string|null>} the cached/fresh pass string, or null when the
 *   caller is anonymous / has no linked wallet (the endpoint 401/403s) or on any
 *   network failure — callers then simply omit the x-three-tier-pass header.
 */
export async function getTierPass() {
	if (isFresh(_cache)) return _cache.pass;

	// A pass minted earlier this tab session is still good after a soft navigation.
	const stored = readStored();
	if (isFresh(stored)) {
		_cache = stored;
		return _cache.pass;
	}

	try {
		const r = await fetch(TIER_PASS_URL, { method: 'POST', credentials: 'include' });
		if (!r.ok) {
			// 401/403 → anonymous or no linked wallet: there's no pass to hold.
			clearTierPass();
			return null;
		}
		const data = await r.json().catch(() => null);
		const pass = data && typeof data.pass === 'string' ? data.pass : null;
		if (!pass) {
			clearTierPass();
			return null;
		}
		const exp = decodePassExpMs(pass) || Date.now() + PASS_FALLBACK_TTL_MS;
		_cache = { pass, exp };
		writeStored(_cache);
		return pass;
	} catch {
		// Transient network error — leave any existing cache for the next attempt.
		return null;
	}
}

/**
 * Read the hold-to-access matrix (no arg) or a single feature's entitlement.
 * @param {string} [feature]  a gated feature id (e.g. 'forge.high').
 * @returns {Promise<object>} the parsed payload, or a Member-shaped fallback
 *   (flagged `_error: true`) on any network failure. Never throws.
 *   Feature shape: { signed_in, wallet_linked, tier:{level,id,label,held_usd},
 *                    access:{ feature, label, why, eligible, required, held,
 *                             reason, pay_per_use } }
 */
export async function getAccess(feature) {
	const url = feature ? `${ACCESS_URL}?feature=${encodeURIComponent(feature)}` : ACCESS_URL;
	try {
		const r = await fetch(url, { credentials: 'include' });
		if (!r.ok) return memberFallback(feature);
		const data = await r.json().catch(() => null);
		return data && typeof data === 'object' ? data : memberFallback(feature);
	} catch {
		return memberFallback(feature);
	}
}

/**
 * Headers to spread into a gated fetch so an eligible holder's entitlement rides
 * along. Returns { 'x-three-tier-pass': <pass> } when a pass is available, else {}.
 * @returns {Promise<Record<string,string>>}
 */
export async function threeHeaders() {
	const pass = await getTierPass();
	return pass ? { 'x-three-tier-pass': pass } : {};
}

/** Drop the cached pass (memory + sessionStorage). Call on wallet change / sign-out. */
export function clearTierPass() {
	_cache = null;
	dropStored();
}

// ── auto-wire ───────────────────────────────────────────────────────────────
// A wallet connect/disconnect changes who the caller is, so any cached pass is now
// for the wrong wallet. Drop it and broadcast `three:tier-changed` so mounted gates
// re-read their access — the one live coupling, kept lightweight.
if (hasWindow && typeof window.addEventListener === 'function') {
	window.addEventListener('wallet:changed', (e) => {
		clearTierPass();
		try {
			window.dispatchEvent(
				new CustomEvent('three:tier-changed', {
					detail: { address: e?.detail?.address ?? null, reason: 'wallet:changed' },
				}),
			);
		} catch {
			/* CustomEvent unsupported — gates also listen to wallet:changed directly */
		}
	});
}

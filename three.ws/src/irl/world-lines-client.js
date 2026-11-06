// World Lines client — the browser side of the proof-of-presence quest API.
//
// Reuses the exact IRL identity + proof-of-presence conventions so a visitor is the
// same person across /irl and /world-lines:
//   · anonymous device token  → localStorage 'irl_device_token', sent as x-irl-device
//   · proof-of-presence fix    → POST /api/irl/fix-token, cached per ~110 m cell, sent
//                                as x-irl-fix on every co-located read/write
// The device token is a bearer credential, so it ONLY ever rides in the header, never a
// URL (mirrors api/_lib/irl-auth.js). The caller's precise GPS is used to mint the fix
// and to prove co-location; it is never persisted by the client and never logged.

const DEVICE_KEY = 'irl_device_token';
const FIX_SKEW_MS = 15_000; // re-mint a little before the token actually expires

function deviceToken() {
	let t = null;
	try {
		t = localStorage.getItem(DEVICE_KEY);
		if (!t) {
			t = (crypto.randomUUID && crypto.randomUUID()) || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			localStorage.setItem(DEVICE_KEY, t);
		}
	} catch {
		/* storage blocked (private mode) — fall back to an ephemeral in-memory token */
		t = _ephemeralDevice || (_ephemeralDevice = `eph-${Math.random().toString(36).slice(2)}`);
	}
	return t;
}
let _ephemeralDevice = null;

function deviceHeaders(extra = {}) {
	const t = deviceToken();
	return t ? { 'x-irl-device': t, ...extra } : { ...extra };
}

// ── Fix token cache ──────────────────────────────────────────────────────────
let _fixToken = null;
let _fixCell = null;
let _fixExpiresAt = 0;

function cellKey(lat, lng) {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return `${lat.toFixed(3)},${lng.toFixed(3)}`; // ~110 m — the fix anchor granularity
}

async function ensureFixToken(lat, lng, accuracy) {
	const cell = cellKey(lat, lng);
	if (!cell) return null;
	if (_fixToken && _fixCell === cell && Date.now() < _fixExpiresAt) return _fixToken;
	try {
		const r = await fetch('/api/irl/fix-token', {
			method: 'POST',
			credentials: 'include',
			headers: deviceHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({ lat, lng, accuracy }),
		});
		if (!r.ok) return null;
		const { token, expires_in } = await r.json();
		if (token) {
			_fixToken = token;
			_fixCell = cell;
			_fixExpiresAt = Date.now() + (Number(expires_in) || 180) * 1000 - FIX_SKEW_MS;
		}
		return token;
	} catch {
		return null;
	}
}

async function presenceHeaders(lat, lng, accuracy, extra = {}) {
	const token = await ensureFixToken(lat, lng, accuracy);
	return deviceHeaders(token ? { 'x-irl-fix': token, ...extra } : { ...extra });
}

async function asJson(r) {
	let body = null;
	try { body = await r.json(); } catch { /* non-JSON */ }
	if (!r.ok) {
		const err = new Error(body?.error_description || body?.message || body?.error || `request failed (${r.status})`);
		err.status = r.status;
		err.code = body?.error;
		err.body = body;
		throw err;
	}
	return body;
}

let _csrf = null;
async function csrfToken() {
	if (_csrf) return _csrf;
	try {
		const r = await fetch('/api/csrf-token', { credentials: 'include' });
		const j = await asJson(r);
		const token = j?.data?.token || j?.token || null;
		_csrf = token;
		return token;
	} catch {
		return null;
	}
}

const BASE = '/api/irl/world-lines';

export const worldLinesClient = {
	deviceToken,

	// Public, coarse region roll-up (no coordinates) — the discovery map.
	async browseRegions() {
		return asJson(await fetch(`${BASE}/browse`, { credentials: 'include' }));
	},
	async browseRegion(region, difficulty) {
		const qs = new URLSearchParams({ region });
		if (difficulty) qs.set('difficulty', difficulty);
		return asJson(await fetch(`${BASE}/browse?${qs}`, { credentials: 'include' }));
	},

	// Fix-gated, co-located discovery — quests within walking range of (lat,lng).
	async nearby(lat, lng, accuracy, radius) {
		const qs = new URLSearchParams({ lat: String(lat), lng: String(lng) });
		if (radius) qs.set('radius', String(radius));
		const headers = await presenceHeaders(lat, lng, accuracy);
		return asJson(await fetch(`${BASE}/nearby?${qs}`, { credentials: 'include', headers }));
	},

	// Single quest detail. Pass the caller's fix so the AR answer is revealed only when
	// co-located (the server redacts the quiz/phrase answer otherwise).
	async getQuest(id, lat, lng, accuracy) {
		const qs = new URLSearchParams();
		if (Number.isFinite(lat) && Number.isFinite(lng)) { qs.set('lat', String(lat)); qs.set('lng', String(lng)); }
		const headers = Number.isFinite(lat) ? await presenceHeaders(lat, lng, accuracy) : deviceHeaders();
		const suffix = qs.toString() ? `?${qs}` : '';
		return asJson(await fetch(`${BASE}/${id}${suffix}`, { credentials: 'include', headers }));
	},

	// Issue a single-use completion nonce (requires server-derived co-location).
	async challenge(worldLineId, lat, lng, accuracy) {
		const headers = await presenceHeaders(lat, lng, accuracy, { 'Content-Type': 'application/json' });
		return asJson(await fetch(`${BASE}/challenge`, {
			method: 'POST', credentials: 'include', headers,
			body: JSON.stringify({ world_line_id: worldLineId, lat, lng, accuracy }),
		}));
	},

	// The proof ceremony. `interaction` carries { answer } (quiz) or { phrase } where needed.
	async complete(worldLineId, nonce, lat, lng, accuracy, interaction = {}) {
		const headers = await presenceHeaders(lat, lng, accuracy, { 'Content-Type': 'application/json' });
		return asJson(await fetch(`${BASE}/complete`, {
			method: 'POST', credentials: 'include', headers,
			body: JSON.stringify({ world_line_id: worldLineId, nonce, lat, lng, accuracy, ...interaction }),
		}));
	},

	// Independent, public verification of a proof.
	async verify(proofId) {
		return asJson(await fetch(`${BASE}/verify/${proofId}`, { credentials: 'include' }));
	},

	// The caller's earned collectibles (device or signed-in user).
	async myCollectibles() {
		return asJson(await fetch(`${BASE}/collectibles`, { credentials: 'include', headers: deviceHeaders() }));
	},

	// Creator dashboard (auth).
	async mine() {
		return asJson(await fetch(`${BASE}/mine`, { credentials: 'include' }));
	},

	// Place a World Line (auth + CSRF).
	async create(payload) {
		const token = await csrfToken();
		const headers = { 'Content-Type': 'application/json' };
		if (token) headers['X-CSRF-Token'] = token;
		return asJson(await fetch(`${BASE}`, {
			method: 'POST', credentials: 'include', headers, body: JSON.stringify(payload),
		}));
	},
};

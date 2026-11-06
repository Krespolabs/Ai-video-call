// IRL proof-of-presence (epic IRL-Hardening H3).
//
// The nearby read (`GET /api/irl/pins`) is the ONLY surface that returns another
// user's pin coordinates, and it does so only within a tight radius of the
// caller. But it has trusted CALLER-SUPPLIED lat/lng: anyone could query any
// point on earth they aren't standing at and harvest the pins there (the radius
// cap + IP rate-limit slow a sweep but don't bind the read to a genuine fix).
//
// A proof-of-presence token closes that hole. The client mints a short-lived,
// HMAC-signed token from its real geolocation fix; the read then only answers for
// the coarse area that token was minted in. "Query anywhere" becomes "query where
// you are" — the actual product contract ("you stumble on an agent by walking up
// to it"), made structural rather than merely rate-limited.
//
// Token shape (compact, URL-safe, stateless — no DB):
//   token   = base64url(JSON payload) + '.' + base64url(HMAC_SHA256(payload))
//   payload = { a: anchorLat, o: anchorLng, c: cell7, iat: issuedAtSec }
// where anchorLat/Lng are the mint fix COARSENED to ANCHOR_DP (~110 m) so the
// token itself never carries a fine coordinate, and cell7 is the geocell-7 the
// fix fell in (handy for the client's "re-mint on cell change" trigger).
//
// Enforcement: a read is allowed when its claimed point is within
// FIX_TOLERANCE_M of the token anchor and the token is unexpired and unforged.
// The tolerance generously covers a cell + its edges (so a viewer near a cell
// boundary keeps polling seamlessly) while staying far too tight to read a city.

import { hmacSha256, constantTimeEquals } from './crypto.js';
import { encodeGeohash } from './geohash.js';

export const FIX_TTL_SEC = 180;        // 3 min — long enough to keep polling as you
                                       // walk a block, short enough to defeat banking.
export const ANCHOR_DP = 3;            // ~110 m coarsening of the mint fix in the token.
export const FIX_TOLERANCE_M = 250;    // a read's claimed point must be within this of
                                       // the token anchor (~1 cell + edge slack).
export const FIX_CELL_PRECISION = 7;   // ~153 m geocell, the client's re-mint trigger.

const SECRET_ENV = 'IRL_FIX_SECRET';

// A stable, deliberately non-secret signing key used ONLY when IRL_FIX_SECRET is
// unset or too weak (local dev / preview). It keeps the mint + verify pair fully
// functional and self-consistent without a configured secret — a token minted in
// this mode verifies in this mode — so the endpoint never crashes and local testing
// isn't blocked. It is NOT a security boundary: `fixEnforced()` stays false in this
// mode, so the nearby read does not gate on the token at all. Production sets a real
// secret (≥16 chars), which both flips enforcement on AND replaces this key, so a
// token minted in bypass mode is rejected (forged) the moment enforcement is live.
const DEV_FALLBACK_SECRET = 'irl-fix:dev+preview-unsecured-key:not-for-production';

// Whether proof-of-presence is enforced. A strong configured secret (≥16 chars) ⇒
// enforced. Unset or too-weak secret ⇒ dev/preview bypass: the read works unchanged
// so local/sandbox testing isn't gated. Production MUST set IRL_FIX_SECRET. Callers
// log the active mode once at cold start.
export function fixEnforced() {
	const s = process.env[SECRET_ENV];
	return typeof s === 'string' && s.length >= 16;
}

// The key the HMAC is actually computed with. Mirrors fixEnforced(): the configured
// secret when it's strong enough, otherwise the stable dev fallback. NEVER returns an
// empty string — a zero-length HMAC key throws "Zero-length key is not supported"
// inside Web Crypto, which is exactly the production crash this guards against.
function effectiveSecret() {
	return fixEnforced() ? process.env[SECRET_ENV] : DEV_FALLBACK_SECRET;
}

function b64urlEncode(str) {
	return Buffer.from(str, 'utf8').toString('base64')
		.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
	const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
	return Buffer.from(str.replaceAll('-', '+').replaceAll('_', '/') + pad, 'base64').toString('utf8');
}

function roundAnchor(v) {
	const f = 10 ** ANCHOR_DP;
	return Math.round(v * f) / f;
}

// Great-circle distance in metres (haversine). Kept local so this module has no
// dependency on the pins handler.
function haversineM(lat1, lng1, lat2, lng2) {
	const R = 6371000;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a = Math.sin(dLat / 2) ** 2
		+ Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Mint a token from a real fix. Returns { token, expires_in, cell } or null when
// the fix is non-finite (unplaceable) — the caller turns null into a 400.
export async function mintFixToken(lat, lng, nowSec = Math.floor(Date.now() / 1000)) {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
	const payload = {
		a: roundAnchor(lat),
		o: roundAnchor(lng),
		c: encodeGeohash(lat, lng, FIX_CELL_PRECISION),
		iat: nowSec,
	};
	const json = JSON.stringify(payload);
	const sig = await hmacSha256(effectiveSecret(), json);
	return {
		token: `${b64urlEncode(json)}.${sig}`,
		expires_in: FIX_TTL_SEC,
		cell: payload.c,
	};
}

// Verify a token authorises a read at the claimed point. Returns
// { ok: true, cell } or { ok: false, reason } — never throws on bad input.
//   reason: 'missing' | 'malformed' | 'forged' | 'expired' | 'out_of_area'
export async function verifyFixToken(token, claimLat, claimLng, nowSec = Math.floor(Date.now() / 1000)) {
	if (typeof token !== 'string' || !token.length) return { ok: false, reason: 'missing' };
	const dot = token.indexOf('.');
	if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

	const encPayload = token.slice(0, dot);
	const sig = token.slice(dot + 1);

	let json;
	try {
		json = b64urlDecode(encPayload);
	} catch {
		return { ok: false, reason: 'malformed' };
	}

	// Recompute the signature over the EXACT decoded JSON and compare in constant
	// time — a forged or tampered payload won't reproduce the HMAC.
	const expected = await hmacSha256(effectiveSecret(), json);
	if (!constantTimeEquals(sig, expected)) return { ok: false, reason: 'forged' };

	let payload;
	try {
		payload = JSON.parse(json);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	const { a, o, c, iat } = payload || {};
	if (!Number.isFinite(a) || !Number.isFinite(o) || !Number.isFinite(iat)) {
		return { ok: false, reason: 'malformed' };
	}
	if (nowSec - iat > FIX_TTL_SEC || iat - nowSec > 60) {
		// Past TTL, or issued implausibly in the future (clock-skew slack 60 s).
		return { ok: false, reason: 'expired' };
	}
	if (!Number.isFinite(claimLat) || !Number.isFinite(claimLng)) {
		return { ok: false, reason: 'out_of_area' };
	}
	// The read's claimed point must sit within tolerance of the token anchor — i.e.
	// the caller is reading roughly where they minted, not a distant cell.
	if (haversineM(a, o, claimLat, claimLng) > FIX_TOLERANCE_M) {
		return { ok: false, reason: 'out_of_area' };
	}
	return { ok: true, cell: typeof c === 'string' ? c : encodeGeohash(a, o, FIX_CELL_PRECISION) };
}

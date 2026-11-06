/**
 * IRL proof-of-presence mint — POST /api/irl/fix-token   (epic IRL-Hardening H3)
 *
 * Body: { lat, lng, accuracy? }  — the caller's CURRENT geolocation fix.
 * Returns: { token, expires_in, cell }
 *
 * The returned token is a short-lived, HMAC-signed proof that the caller had a
 * real fix in a coarse (~150 m) cell. The nearby read (GET /api/irl/pins) then
 * only answers for that area, so a viewer can't browse pins at a location they
 * aren't standing near. Stateless: no DB row, no stored coordinate (the token
 * anchor is coarsened to ~110 m inside api/_lib/irl-presence.js).
 *
 * Privacy: the fix never reaches a log line — this handler reads lat/lng only to
 * mint, never persists or prints them, and the response is no-store. A 5xx here
 * routes through the same redactUrl scrub as every other geolocated path.
 *
 * Rate-limited per IP (irlFixIp): a walking viewer re-mints only on a cell change
 * (~every 150 m), so the budget is generous for real use and tight for a sweep
 * that would need to mint many distinct cells.
 */

import { cors, json, wrap, error, rateLimited, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { mintFixToken, fixEnforced } from '../_lib/irl-presence.js';

// Log the active enforcement mode exactly once per cold start so a prod misconfig
// (secret unset ⇒ bypass) is visible without spamming every request.
let _modeLogged = false;
function logModeOnce() {
	if (_modeLogged) return;
	_modeLogged = true;
	console.log(`[irl] proof-of-presence ${fixEnforced() ? 'ENFORCED' : 'BYPASS (IRL_FIX_SECRET unset — dev/preview)'}`);
}

export default wrap(async (req, res) => {
	cors(req, res, { methods: ['POST', 'OPTIONS'] });
	if (req.method === 'OPTIONS') return res.end();
	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method not allowed');

	logModeOnce();

	const rl = await limits.irlFixIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'bad_request', err.message || 'invalid body');
	}

	const lat = parseFloat(body?.lat);
	const lng = parseFloat(body?.lng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
		return error(res, 400, 'fix_invalid', 'a live latitude and longitude are required');
	}

	const minted = await mintFixToken(lat, lng);
	if (!minted) return error(res, 400, 'fix_invalid', 'latitude/longitude out of range');

	return json(res, 200, minted);
});

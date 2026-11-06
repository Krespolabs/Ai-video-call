// GET /api/billboard?coin=<mint>
//
// Free read side of the coin-world billboard. Returns the active paid placement
// for a coin-world, or { placement: null } when nobody holds the board (or the
// slot expired). The 3D world at /temporary fetches this on boot — if a
// placement exists it renders that content on the in-world panel instead of the
// world's default. Setting a placement is paid: see /api/x402/billboard.
//
// Fails open: a Redis outage or a bad mint returns { placement: null } with 200
// so the world simply shows its default content rather than erroring.

import { cors, json, method, wrap } from './_lib/http.js';
import { getPlacement, isValidCoin, SLOT_HOURS } from './_lib/billboard-store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const coin = String(req.query?.coin || '').trim();
	if (!isValidCoin(coin)) {
		return json(res, 200, { placement: null, slotHours: SLOT_HOURS });
	}

	const placement = await getPlacement(coin);
	// Short cache: placements change rarely (a 6-hour slot), but a fresh visitor
	// should see a new holder within a minute.
	res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
	return json(res, 200, { placement: placement || null, slotHours: SLOT_HOURS });
});

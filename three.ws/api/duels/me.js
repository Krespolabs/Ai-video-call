// GET /api/duels/me
// ---------------------------------------------------------------------------
// The signed-in predictor: today's free allowance (credited by this read if it
// has not been yet), points balance, XP level including XP from correct calls,
// this season's standing, recent calls and duel badges. Signed out, it answers
// { signed_in: false } with the rules so the page can explain the game.
// Points have no cash value and cannot be bought, sold, transferred or redeemed.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { loadPredictor, DUEL_RULES } from '../_lib/trader-duels.js';
import { duelCaller } from './_auth.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	res.setHeader?.('cache-control', 'private, no-store');
	const caller = await duelCaller(req);
	if (!caller) return json(res, 200, { signed_in: false, rules: DUEL_RULES });

	const me = await loadPredictor(caller.userId);
	return json(res, 200, { signed_in: true, rules: DUEL_RULES, ...me });
});

// GET  /api/duels/:id                      one duel: both traders' 30-day records,
//                                          the in-window standing, the crowd, and
//                                          whether the viewer can call it
// POST /api/duels/:id  { side, stake }     make a call (signed in)
// ---------------------------------------------------------------------------
// Free to play: a call stakes duel points from the free daily allowance, and
// points have no cash value. One call per user per duel, locked when the window
// starts, never on a duel involving an agent the caller owns. See
// api/_lib/trader-duels.js for the rules and how a duel resolves.

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { getDuel, placeCall, DUEL_RULES } from '../_lib/trader-duels.js';
import { duelCaller } from './_auth.js';

/** The duel id is the path segment; route params win over the query string. */
export function duelIdFromRequest(req) {
	const fromRoute = req?.query?.id;
	let raw = typeof fromRoute === 'string' && fromRoute ? fromRoute : '';
	if (!raw) {
		const segments = new URL(req?.url || '/', 'http://x').pathname.split('/').filter(Boolean);
		raw = segments[segments.length - 1] || '';
	}
	return isUuid(raw) ? raw.toLowerCase() : null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const id = duelIdFromRequest(req);
	if (!id) return error(res, 404, 'not_found', 'No such duel.');

	if (req.method === 'GET') {
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		const caller = await duelCaller(req);
		const duel = await getDuel(id, { userId: caller?.userId ?? null });
		if (!duel) return error(res, 404, 'not_found', 'No such duel. It may have been removed, or the link is incomplete.');
		res.setHeader?.('cache-control', 'private, no-store');
		return json(res, 200, { duel, rules: DUEL_RULES, t: Date.now() });
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const caller = await duelCaller(req);
	if (!caller) return error(res, 401, 'unauthorized', 'Sign in to make a call. It is free.');
	if (caller.viaSession && !(await requireCsrf(req, res, caller.userId))) return;

	const body = await readJson(req).catch(() => null);
	if (!body || typeof body !== 'object') return error(res, 400, 'invalid_body', 'Send JSON: { "side": "a" | "b", "stake": number }.');

	const result = await placeCall({ userId: caller.userId, marketId: id, side: body.side, stake: body.stake });
	if (!result.ok) return error(res, result.status, result.code, result.message);
	return json(res, 201, { ok: true, call: result.call, balance: result.balance });
});

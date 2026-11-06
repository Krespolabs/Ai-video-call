// Syndicate membership for the signed-in copier.
// ---------------------------------------------------------------------------
//   GET  /api/syndicates/membership?slug=<slug>
//        Your relationship to a syndicate: whether you are in it, the copy
//        subscriptions your membership rides on (and which ones the join
//        created), whether you run one of its leaders, and which other
//        syndicate you are in, if any.
//
//   POST /api/syndicates/membership  { slug, action: 'join', copier_wallet, sizing_rule, fixed_sol,
//                                      multiplier, pct_balance, per_trade_cap_sol, daily_budget_sol,
//                                      max_drawdown_pct?, ...the /api/copy/subscriptions tunables }
//        Join: one real copy subscription per syndicate leader through the same
//        guarded path as a single follow (self-copy refusal, the copyable bar,
//        your own caps). A subscription you already had to a leader is linked,
//        never overwritten. One syndicate per copier per network.
//
//   POST /api/syndicates/membership  { slug, action: 'leave' }
//        Leave: stops only the subscriptions the join created; any you had
//        before joining keep running exactly as they were.
//
// Auth required; cookie-session writes also need a CSRF token. Non-custodial:
// only your wallet ADDRESS and rules are stored, and your wallet signs every trade.

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { joinSyndicate, leaveSyndicate, loadMembership, slugifyName } from '../_lib/syndicates.js';

const cleanSlug = (v) => {
	const s = String(v || '').trim().toLowerCase();
	return slugifyName(s) === s ? s : null;
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'Sign in to join a syndicate.');
	const userId = session?.id ?? bearer.userId;

	if (req.method === 'GET') {
		const slug = cleanSlug(new URL(req.url, 'http://x').searchParams.get('slug'));
		if (!slug) return error(res, 400, 'invalid_slug', 'slug is required');
		const membership = await loadMembership(userId, slug);
		if (!membership) return error(res, 404, 'not_found', 'No such syndicate.');
		res.setHeader?.('cache-control', 'private, no-store');
		return json(res, 200, { membership });
	}

	if (session && !(await requireCsrf(req, res, userId))) return;

	const body = await readJson(req).catch(() => null);
	if (!body || typeof body !== 'object') return error(res, 400, 'bad_request', 'JSON body required');
	const slug = cleanSlug(body.slug);
	if (!slug) return error(res, 400, 'invalid_slug', 'slug is required');

	if (body.action === 'join') {
		const result = await joinSyndicate({ userId, slug, body });
		if (!result.ok) return error(res, result.status, result.code, result.message, result.extra);
		return json(res, result.already ? 200 : 201, { joined: !result.already, already: result.already, membership: result.membership });
	}
	if (body.action === 'leave') {
		const result = await leaveSyndicate({ userId, slug });
		if (!result.ok) return error(res, result.status, result.code, result.message, result.extra);
		return json(res, 200, { left: true, stopped_subscriptions: result.stopped_subscriptions, kept_subscriptions: result.kept_subscriptions });
	}
	return error(res, 400, 'invalid_action', "action must be 'join' or 'leave'");
});

// POST /api/quests/claim  { day: 'YYYY-MM-DD' }
// ---------------------------------------------------------------------------
// Claim the $THREE reward for a cleared day (today or yesterday, UTC). This is
// the only quest path that can move funds, so it is DISARMED by default: until
// the owner sets TRADING_QUEST_THREE_REWARDS=on with an amount and a funded
// payout key, it answers 409 rewards_disarmed and touches nothing. See
// api/_lib/quest-rewards.js for the full contract.

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { claimDailyClearReward } from '../_lib/quest-rewards.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;
	if (session && !(await requireCsrf(req, res, userId))) return;

	const body = await readJson(req).catch(() => null);
	const day = typeof body?.day === 'string' && DAY_RE.test(body.day) ? body.day : null;
	if (!day) return error(res, 400, 'invalid_day', 'day must be YYYY-MM-DD');

	const result = await claimDailyClearReward({ userId, day });
	if (!result.ok) return error(res, result.status, result.code, result.message, result.extra);
	return json(res, 200, result);
});

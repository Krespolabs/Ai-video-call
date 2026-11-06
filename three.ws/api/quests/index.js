// GET /api/quests
// ---------------------------------------------------------------------------
// Today's trading quests. Signed out: the real quest catalog with no progress,
// so the page can show what there is to do. Signed in: progress computed from
// proof tables (verified trades, forks, first ghost-copies, acted copy intents,
// an owned agent's profitable live closes), with anything newly earned today or
// yesterday awarded on this read, plus XP level, daily-clear streak, and quest
// badges. See api/_lib/trading-quests.js.
//
// `three_rewards.armed` says whether a daily clear also pays $THREE. It is false
// unless the owner switched TRADING_QUEST_THREE_REWARDS on (api/_lib/quest-rewards.js).

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { loadQuestBoard, questCatalog } from '../_lib/trading-quests.js';
import { questRewardConfig, publicRewardInfo } from '../_lib/quest-rewards.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const cfg = questRewardConfig();
	const rewards = publicRewardInfo(cfg);

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;
	res.setHeader?.('cache-control', 'private, no-store');

	if (!userId) return json(res, 200, { signed_in: false, ...questCatalog(), three_rewards: rewards });

	const board = await loadQuestBoard(userId);
	if (cfg.armed) {
		const claims = await sql`
			select day::text as day, status, tx_signature from trading_quest_three_rewards
			where user_id = ${userId} and day in (${board.day}::date, ${board.yesterday.day}::date)
		`;
		rewards.claims = claims;
	}
	return json(res, 200, { signed_in: true, ...board, three_rewards: rewards });
});

// @ts-check
// GET /api/cron/big-win-x: the big-win auto-poster for @trythreews.
//
// Every tick selects the best live, sized win closed in the lookback window and
// composes its post (docs/growth-programs.md). Posting to X is owner-gated, so
// unless BIG_WIN_X_ENABLED is exactly "1"/"true" the tick is a dry run: it
// returns the post it WOULD send and writes nothing. Armed, it sends at most one
// post per tick under the lane's daily cap and the account-wide cap shared with
// the changelog and content lanes.

import { json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import { programConfig } from '../_lib/growth-programs/config.js';
import { runBigWinLane } from '../_lib/growth-programs/big-win-x.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const cfg = programConfig().bigWinX;
	const result = await runBigWinLane({ cfg });
	// The per-candidate list is for the ops report; the cron log keeps the verdict.
	const { considered, ...summary } = result;
	return json(res, 200, { ok: true, ...summary, considered_count: considered.length });
});

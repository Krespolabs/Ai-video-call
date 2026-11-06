// @ts-check
// GET/POST /api/cron/creator-earnings-snapshot: refresh what every agent coin's
// creator has earned in pump.fun creator fees (every 30 minutes, Cloud
// Scheduler). The work lives in api/_lib/creator-earnings-snapshot.js; this is
// only the authenticated trigger.
//
// Response: { ok, coins, wallets, refreshed, upstream_failed, skipped[], wallet_errors[] }.
// `skipped` names every coin that got no figure this run and why, so a coin is
// never silently missing from the earnings surfaces.
//
// Auth: CRON_SECRET Bearer (same gate as every cron endpoint).

import { json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import { runCreatorEarningsSnapshot } from '../_lib/creator-earnings-snapshot.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;
	const out = await runCreatorEarningsSnapshot();
	return json(res, 200, { ok: true, ...out });
});

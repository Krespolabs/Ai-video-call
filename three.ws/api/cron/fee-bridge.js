// @ts-check
// GET/POST /api/cron/fee-bridge: one Fee Bridge engine pass (every 10 minutes).
//
// Settles earlier sends, cranks each registered coin's creator-fee distribution
// into the bridge wallet, advances the SOL -> USDC -> $THREE conversion batch, and
// pays linked recipients past the auto-payout floor. See api/_lib/fee-bridge/engine.js
// and docs/fee-bridge.md.
//
// Off until FEE_BRIDGE_ENABLED is truthy and FEE_BRIDGE_SECRET_KEY_B64 is set.
// `?dry=1` reports what the pass would do from live chain + DB state without
// signing anything, and runs even while the bridge is disabled.
//
// Auth: CRON_SECRET Bearer.

import { json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import { runTick } from '../_lib/fee-bridge/engine.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;
	const url = new URL(req.url, 'http://x');
	const dryRun = /^(1|true)$/i.test(url.searchParams.get('dry') || '');
	const out = await runTick({ dryRun });
	return json(res, 200, out);
});

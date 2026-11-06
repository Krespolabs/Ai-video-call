/**
 * Copy-trading earnings / fees owed.
 *
 *   GET /api/copy/earnings?agent_id=<leader>&network=  (public)
 *       Aggregate copy earnings for a leader — the "this trader has earned X for
 *       being copied" social-proof figure. No per-copier identity is exposed.
 *
 *   GET /api/copy/earnings  (auth)
 *       The signed-in copier's performance fees owed across the traders they copy,
 *       per subscription, with the leader's name. Drives the dashboard summary.
 *
 * All figures are real — derived from the copier's acted copies matched to the
 * leader's closed positions, above each subscription's high-water mark.
 */

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { accruedLeaderEarnings, subscriptionOwed } from '../_lib/copy-earnings.js';
import { isUuid } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const agentId = (params.get('agent_id') || '').trim();

	// Public leader aggregate.
	if (agentId) {
		if (!isUuid(agentId)) return error(res, 400, 'invalid_agent', 'agent_id must be a UUID');
		const earnings = await accruedLeaderEarnings(agentId, network);
		return json(res, 200, { agent_id: agentId, network, ...earnings },
			{ 'cache-control': 'public, max-age=30, s-maxage=60' });
	}

	// Copier's own owed summary (auth required).
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const subs = await sql`
		select s.*, a.name as leader_name, a.profile_image_url as leader_image, a.avatar_url as leader_avatar
		from copy_subscriptions s
		join agent_identities a on a.id = s.leader_agent_id
		where s.copier_user_id = ${userId} and s.status <> 'stopped'
	`;
	const items = [];
	let totalOwed = 0;
	for (const sub of subs) {
		const owed = await subscriptionOwed(sub);
		if (owed.cumulative_profit_sol === 0 && owed.fee_sol === 0) continue;
		items.push({
			subscription_id: sub.id,
			leader_agent_id: sub.leader_agent_id,
			leader_name: sub.leader_name,
			leader_image: sub.leader_image || sub.leader_avatar || null,
			perf_fee_bps: Number(sub.perf_fee_bps),
			...owed,
		});
		totalOwed += owed.fee_sol;
	}
	return json(res, 200, { total_fee_owed_sol: Math.round(totalOwed * 1e6) / 1e6, items });
});

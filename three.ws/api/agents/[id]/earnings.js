// GET /api/agents/:id/earnings[?window=24h|7d|30d|all]: what an agent has
// earned, publicly. Creator fees from the coins it launched on pump.fun (earned,
// claimed, unclaimed, per coin, with the recorded claim transactions) plus its
// service income (x402 skill sales and hires), in SOL and USD.
//
// Public on purpose: creator fees and claims are on-chain for anyone to read,
// and service income is the headline an agent's builder wants to show. A private
// agent answers 404 to everyone but its owner.
//
// The computation lives in api/_lib/agent-earnings.js and is shared with
// GET /api/leaderboard/earnings, so the two can never disagree. Figures come
// from the snapshot the creator-earnings cron refreshes every 30 minutes;
// `refreshed_at` says how old they are and `method` says where they come from.

import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { isUuid } from '../../_lib/validate.js';
import { getAgentEarnings } from '../../_lib/agent-earnings.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const id = url.searchParams.get('id') || url.pathname.split('/').filter(Boolean)[2];
	// The vercel.json rewrite lands here directly, so the uuid gate api/agents/[id].js
	// applies never runs; a malformed id must not reach a uuid column as a 500.
	if (!isUuid(id)) return error(res, 404, 'not_found', 'agent not found');

	const [agent] = await sql`
		select id, name, is_public, user_id, meta->>'solana_address' as solana_address
		from agent_identities
		where id = ${id} and deleted_at is null
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (!agent.is_public) {
		const viewer = await getSessionUser(req).catch(() => null);
		if (!viewer || viewer.id !== agent.user_id) return error(res, 404, 'not_found', 'agent not found');
	}

	const body = await getAgentEarnings(agent, { window: url.searchParams.get('window') || 'all' });
	res.setHeader(
		'cache-control',
		agent.is_public ? 'public, max-age=60, s-maxage=120, stale-while-revalidate=300' : 'private, no-store',
	);
	return json(res, 200, body);
});

// GET /api/duels?phase=open|live|settled|all&agent=<agent id>&network=mainnet&limit=30
// ---------------------------------------------------------------------------
// Trader duels on the board: head-to-head calls on which of two traders books
// more realized P&L over a fixed UTC window. Free to play; points have no cash
// value. Each duel carries both traders, the window, its phase, the crowd's
// split, and, for a signed-in viewer, their own call. `counts` feeds the tabs
// and `eligible_traders` explains an empty board. See api/_lib/trader-duels.js.

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import { listDuels, duelCounts, eligibleTraderCount, DUEL_RULES, NETWORKS, PHASES } from '../_lib/trader-duels.js';
import { duelCaller } from './_auth.js';

const MAX_LIMIT = 60;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = params.get('network') || 'mainnet';
	if (!NETWORKS.has(network)) return error(res, 400, 'invalid_network', 'network must be mainnet or devnet');
	const phase = params.get('phase') || 'all';
	if (!PHASES.has(phase)) return error(res, 400, 'invalid_phase', `phase must be one of ${[...PHASES].join(', ')}`);
	const agent = params.get('agent');
	if (agent && !isUuid(agent)) return error(res, 400, 'invalid_agent', 'agent must be an agent id');
	const rawLimit = params.get('limit');
	let limit = 30;
	if (rawLimit != null && rawLimit !== '') {
		const n = Number(rawLimit);
		if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
			return error(res, 400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_LIMIT}`);
		}
		limit = n;
	}

	const caller = await duelCaller(req);
	const now = Date.now();
	const [duels, counts, eligible] = await Promise.all([
		listDuels({ network, phase, agentId: agent, userId: caller?.userId ?? null, limit, now }),
		duelCounts({ network, now }),
		eligibleTraderCount({ network, now }),
	]);

	res.setHeader?.('cache-control', 'private, no-store');
	return json(res, 200, {
		network,
		phase,
		agent: agent || null,
		signed_in: !!caller,
		rules: DUEL_RULES,
		counts,
		eligible_traders: eligible,
		duels,
		t: now,
	});
});

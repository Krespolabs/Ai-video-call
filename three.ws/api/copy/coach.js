/**
 * Copy Coach: the guided first copy for a cautious newcomer (/copy-coach).
 *
 *   GET  /api/copy/coach?network=mainnet
 *        { win, leaders[], starter_caps, eligibility_bar, generated_at }
 *        win      the most recent real (signed) closed win of 25%+, with the
 *                 30-day record of the agent that made it, or null
 *        leaders  ghost-copyable leaders, each marked copyable or not against
 *                 the real eligibility bar (unmet criteria in words)
 *
 *   POST /api/copy/coach { message, history?, step?, leader_id?, window?, budget_sol?, network? }
 *        { reply, source: 'llm'|'guide', model?, facts_used }
 *        One question to the coach. The reply is grounded in a fact sheet built
 *        here from real rows (the verified win, the chosen leader, and a ghost
 *        replay recomputed server side), checked by validateCoachReply, and
 *        replaced by the deterministic guide when the chain is down or the
 *        reply fails the check.
 *
 * Public: steps 1 and 2 need no account. The real copy (step 3) is created by
 * POST /api/copy/subscriptions with `starter: true`, where STARTER_CAPS are
 * enforced server side. This endpoint never moves or commits funds.
 */

import { cors, json, method, wrap, error, rateLimited, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cacheWrap } from '../_lib/cache.js';
import { isUuid } from '../_lib/validate.js';
import {
	COACH_STEPS, STARTER_CAPS, LEADER_ELIGIBILITY,
	loadVerifiedWin, loadCoachLeaders, loadGhostFacts, buildCoachFacts, coachReply,
} from '../_lib/copy-coach.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const GHOST_WINDOWS = new Set(['24h', '7d', '30d', 'all']);

export const maxDuration = 45;

async function overview(network) {
	return cacheWrap(`copy-coach:overview:v1:${network}`, 60, async () => {
		const [win, leaders] = await Promise.all([loadVerifiedWin(network), loadCoachLeaders(network)]);
		return { network, win, leaders, starter_caps: STARTER_CAPS, eligibility_bar: LEADER_ELIGIBILITY, generated_at: new Date().toISOString() };
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') {
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
		const network = params.get('network') || 'mainnet';
		if (!NETWORKS.has(network)) return error(res, 400, 'invalid_network', 'network must be mainnet or devnet');
		return json(res, 200, await overview(network), { 'cache-control': 'public, max-age=30, s-maxage=60' });
	}

	const rl = await limits.copyCoachIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch {
		return error(res, 400, 'invalid_json', 'Body must be JSON');
	}
	const message = typeof body?.message === 'string' ? body.message.trim() : '';
	if (!message) return error(res, 400, 'invalid_message', 'Ask the coach a question');
	if (message.length > 500) return error(res, 400, 'message_too_long', 'Keep the question under 500 characters');
	const network = NETWORKS.has(body.network) ? body.network : 'mainnet';
	const step = COACH_STEPS.includes(body.step) ? body.step : 'see_a_win';
	const leaderId = body.leader_id != null && body.leader_id !== '' ? String(body.leader_id) : null;
	if (leaderId && !isUuid(leaderId)) return error(res, 400, 'invalid_leader', 'leader_id must be an agent UUID');
	const window = GHOST_WINDOWS.has(body.window) ? body.window : '30d';
	const budget = Number(body.budget_sol);
	const budgetSol = Number.isFinite(budget) && budget > 0 && budget <= 10_000 ? budget : 1;

	const ov = await overview(network);
	const leader = leaderId ? ov.leaders.find((l) => l.agent_id === leaderId) || null : null;
	const ghost = leaderId ? await loadGhostFacts({ leaderId, network, window, budgetSol }).catch(() => null) : null;
	const facts = buildCoachFacts({ step, win: ov.win, leader, ghost });

	const answer = await coachReply({ message, history: body.history, step, facts });
	return json(res, 200, {
		reply: answer.reply,
		source: answer.source,
		model: answer.model || null,
		facts_used: { win: !!ov.win, leader: !!leader, ghost: !!ghost },
	}, { 'cache-control': 'no-store' });
});

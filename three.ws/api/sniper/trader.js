/**
 * Trader profile — full track record for one agent.
 *
 *   GET /api/sniper/trader?agent_id=<uuid>&network=mainnet&window=30d
 *
 * Powers the /trader/:id page and the Proof tab: composite score, every headline
 * metric, the full closed-trade history (each row carrying its on-chain buy/sell
 * Solscan links), and the currently-open positions with live unrealized P&L. All
 * numbers come from agent_sniper_positions via the shared trader-stats truth
 * layer, so the profile and the leaderboard can never disagree.
 *
 * Public + IP rate-limited — the tx signatures ARE the proof, so anyone may read.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getTraderStats, WINDOWS } from '../_lib/trader-stats.js';
import { isUuid } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const agentId = (params.get('agent_id') || params.get('agent') || '').trim();
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const window = WINDOWS.has(params.get('window')) ? params.get('window') : 'all';

	if (!isUuid(agentId)) {
		return error(res, 400, 'invalid_agent', 'agent_id must be a valid agent UUID');
	}

	const stats = await getTraderStats({ agentId, network, window });
	if (!stats) {
		return error(res, 404, 'not_found', 'No such agent, or it is not public.');
	}
	if (!stats.agent.is_public) {
		return error(res, 404, 'not_found', 'No such agent, or it is not public.');
	}

	return json(res, 200, stats, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});

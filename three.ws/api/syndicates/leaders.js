// GET /api/syndicates/leaders?network=mainnet&limit=12
// ---------------------------------------------------------------------------
// The leaders a syndicate can be founded around: public trader agents with
// closed on-chain round-trips, each with its whole record (settled trades, win
// rate, realized P&L on capital deployed, max drawdown) and the copyable verdict
// a follow has to clear, with every unmet criterion named. Copyable leaders
// come first. Public and cacheable; reads settled history only.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { loadFoundingCandidates } from '../_lib/syndicates.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const q = new URL(req.url, 'http://x').searchParams;
	const network = NETWORKS.has(q.get('network')) ? q.get('network') : 'mainnet';
	const limit = Math.min(50, Math.max(1, parseInt(q.get('limit') || '12', 10) || 12));

	const out = await loadFoundingCandidates(network, { limit });
	res.setHeader?.('cache-control', 'public, max-age=60, s-maxage=120');
	return json(res, 200, out);
});

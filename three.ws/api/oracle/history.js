/**
 * Oracle — conviction score history for a single coin.
 *
 *   GET /api/oracle/history?mint=<base58>&network=mainnet&hours=72
 *
 * Returns the time-series of conviction scores for a coin as recorded by the
 * oracle_conviction_history table. Points are written whenever the score changes
 * by ≥3 pts so the series captures real signal, not polling noise.
 *
 * Used by the coin drawer to render a sparkline showing whether conviction is
 * rising, peaking, or fading — a key signal for entry timing.
 *
 * Public, IP rate-limited, 60-second CDN cache.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { readScoreHistory } from '../_lib/oracle/store.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const MINT_RE  = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params  = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const mint    = (params.get('mint') || '').trim();
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const hours   = Math.min(72, Math.max(1, Number(params.get('hours')) || 72));

	if (!MINT_RE.test(mint)) return error(res, 400, 'validation_error', 'invalid mint');

	const points = await readScoreHistory(mint, network, hours);

	// Compute simple trend: slope of score across the window.
	let trend = null;
	if (points.length >= 2) {
		const first = points[0].score;
		const last  = points[points.length - 1].score;
		const delta = last - first;
		trend = delta > 3 ? 'rising' : delta < -3 ? 'falling' : 'stable';
	}

	return json(res, 200, { mint, network, hours, trend, points }, {
		'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=120',
	});
});

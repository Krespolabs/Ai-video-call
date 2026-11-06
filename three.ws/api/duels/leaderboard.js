// GET /api/duels/leaderboard?season=YYYY-MM&limit=25
// ---------------------------------------------------------------------------
// The season's predictors, ranked by net points from decided calls on duels
// resolved inside the season (a UTC calendar month; defaults to the current
// one). Ties break on more correct calls, then fewer calls. Void duels never
// count. A signed-in viewer outside the top rows still gets their own row as
// `me`. Points have no cash value.

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { seasonLeaderboard, seasonFor, seasonById } from '../_lib/trader-duels.js';
import { duelCaller } from './_auth.js';

const MAX_LIMIT = 100;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const rawSeason = params.get('season');
	const season = rawSeason ? seasonById(rawSeason) : seasonFor();
	if (!season) return error(res, 400, 'invalid_season', 'season must be YYYY-MM');
	const rawLimit = params.get('limit');
	let limit = 25;
	if (rawLimit != null && rawLimit !== '') {
		const n = Number(rawLimit);
		if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
			return error(res, 400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_LIMIT}`);
		}
		limit = n;
	}

	const caller = await duelCaller(req);
	const board = await seasonLeaderboard({ season, limit, userId: caller?.userId ?? null });
	res.setHeader?.('cache-control', 'private, no-store');
	return json(res, 200, { ...board, t: Date.now() });
});

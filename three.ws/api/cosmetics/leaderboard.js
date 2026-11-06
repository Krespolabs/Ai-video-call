// GET /api/cosmetics/leaderboard?limit=<n>
//
// The platform-wide cosmetics flex surface (R25): rarest fits (premium cosmetics
// ranked by on-chain scarcity), top collectors (rarity-weighted flex score), top
// creators (real settled cosmetic earnings in USDC), and the latest sales. Every
// number is read straight from the settled-sale ledger — nothing simulated. Public
// + briefly cached so the /play flex panel and any embed can poll it cheaply.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cosmeticsLeaderboard } from '../_lib/cosmetics-economy.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 12));

	let board;
	try {
		board = await cosmeticsLeaderboard({ limit });
	} catch (err) {
		// No DB / cold table → an honest empty board, not a 500. The flex surface
		// renders its empty state ("be the first to flex a rare fit").
		console.warn('[cosmetics/leaderboard] read failed:', err?.message);
		board = { currency: 'USDC', rarestFits: [], topCollectors: [], topCreators: [], recent: [] };
	}

	return json(res, 200, board, {
		'cache-control': 'public, max-age=15, s-maxage=30, stale-while-revalidate=60',
	});
});

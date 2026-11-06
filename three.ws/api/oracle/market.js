/**
 * Oracle — live market intel for one coin.
 *
 *   GET /api/oracle/market?mint=<mint>&network=mainnet
 *
 * The market-data half of the Oracle coin page: price + 5m/1h/6h/24h changes,
 * market cap, FDV, liquidity, 24h volume, holder count, supply, bonding-curve
 * progress, security posture (mint/freeze authority, mutable metadata, transfer
 * fee, top-10 concentration), DEX pairs, ATH/ATL for listed coins, and every
 * social/explorer link — fused live across DexScreener, pump.fun, GeckoTerminal,
 * GoPlus, Birdeye and CoinGecko. Complements /api/oracle/coin (conviction) so the
 * page paints a complete, fully-populated coin profile.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { fetchCoinMarket } from '../_lib/oracle/market.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const mint = (url.searchParams.get('mint') || '').trim();
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';

	if (!MINT_RE.test(mint)) return error(res, 400, 'validation_error', 'a valid base58 mint is required');

	let market;
	try {
		market = await fetchCoinMarket(mint, network);
	} catch {
		// Every upstream threw — a transient outage, not "no such coin". Surface 503
		// so clients (and the CDN) retry instead of caching a false negative.
		return error(res, 503, 'market_unavailable', 'live market data is temporarily unavailable — retry shortly');
	}

	if (!market || market.price?.usd == null) {
		// No source knows a tradeable price for this mint yet. Cache the negative
		// answer briefly so a fresh mint the pollers hit doesn't re-fan-out to six
		// upstreams on every request; it becomes known within seconds of listing.
		return json(res, 404, { error: 'not_found', error_description: 'no live market found for this mint yet', mint, network }, {
			'cache-control': 'public, max-age=15, s-maxage=30, stale-while-revalidate=60',
		});
	}

	return json(res, 200, market, {
		'Cache-Control': 'public, max-age=15, s-maxage=45, stale-while-revalidate=60',
	});
});

/**
 * Oracle — search coins by symbol or name.
 *
 *   GET /api/oracle/search?q=<term>&network=mainnet&limit=10
 *
 * Fuzzy-matches symbol and name columns in the oracle_conviction cache using
 * ILIKE. Returns up to 10 results sorted by score desc so the most-confident
 * matches surface first. Useful for the Oracle feed search box and any surface
 * where users know a coin name but not its mint.
 *
 * Public, IP rate-limited, 10-second CDN cache.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { QUOTE_MINT_LIST } from '../_lib/quote-mints.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params  = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const q       = (params.get('q') || '').trim().slice(0, 40);
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const limit   = Math.min(20, Math.max(1, Number(params.get('limit')) || 10));

	if (!q) return error(res, 400, 'validation_error', 'q is required');

	const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

	const rows = await sql`
		select mint, symbol, name, score, tier, image_uri, category
		from oracle_conviction
		where network = ${network}
		  and (symbol ilike ${pattern} or name ilike ${pattern})
		  and mint <> all(${QUOTE_MINT_LIST}::text[])
		order by score desc nulls last
		limit ${limit}
	`;

	const items = rows.map((r) => ({
		mint:      r.mint,
		symbol:    r.symbol,
		name:      r.name,
		score:     r.score != null ? Number(r.score) : null,
		tier:      r.tier,
		image_uri: r.image_uri,
		category:  r.category,
	}));

	return json(res, 200, { q, network, items }, {
		'cache-control': 'public, max-age=10, s-maxage=10, stale-while-revalidate=30',
	});
});

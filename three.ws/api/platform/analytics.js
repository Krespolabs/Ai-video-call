// GET /api/platform/analytics?window=30d|90d|all
//
// Every public three.ws platform total in one read, each with a zero-filled
// daily series over the window and a `method` string that says how it was
// counted. The data layer is api/_lib/platform-analytics.js; this handler adds
// the shared cache, the CDN header and the rate limit.
//
// A failing sub-query yields `null` for its metrics plus an `errors` entry. The
// page still renders every other number, so this endpoint answers 200 even
// when a table is unreachable. A partial read is cached for 30 seconds only, so
// a transient failure is not parked on the CDN for five minutes.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { readPlatformAnalytics, resolveWindow } from '../_lib/platform-analytics.js';

export const config = { runtime: 'nodejs' };

const CACHE_TTL_S = 300;
const PARTIAL_TTL_S = 30;
const CACHE_VERSION = 'v1';

const inflight = new Map();

async function computeCached(windowKey) {
	const key = `platform:analytics:${CACHE_VERSION}:${windowKey}`;
	const hit = await cacheGet(key);
	if (hit && typeof hit === 'object' && hit.metrics) return hit;
	// Single-flight per window: a cache expiry under traffic fires one set of
	// aggregate queries, not one per concurrent request.
	if (!inflight.has(windowKey)) {
		const p = readPlatformAnalytics({ window: windowKey })
			.then(async (body) => {
				await cacheSet(key, body, body.errors.length ? PARTIAL_TTL_S : CACHE_TTL_S);
				return body;
			})
			.finally(() => inflight.delete(windowKey));
		inflight.set(windowKey, p);
	}
	return inflight.get(windowKey);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const windowKey = resolveWindow(url.searchParams.get('window'));
	const body = await computeCached(windowKey);

	const cacheControl = body.errors.length
		? `public, s-maxage=${PARTIAL_TTL_S}`
		: `public, s-maxage=${CACHE_TTL_S}, stale-while-revalidate=600`;
	return json(res, 200, body, { 'cache-control': cacheControl });
});

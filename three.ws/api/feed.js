// GET /api/feed — data source for the site-wide live activity ticker.
//
// Public, read-only and cache-friendly. Events are produced across the platform
// (see api/_lib/feed.js); the widget (public/feed.js) polls this every few
// seconds and prepends anything new it hasn't seen. Returns newest-first.

import { wrap, cors, method, json } from './_lib/http.js';
import { readFeedEvents } from './_lib/feed.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const rawLimit = Number(url.searchParams.get('limit'));
	const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 100) : 30;
	const events = await readFeedEvents(limit);

	return json(
		res,
		200,
		{ events, count: events.length },
		// Shared edge cache bounds how often polls fall through to Redis. The
		// widget polls every ~20s; an s-maxage at least that long means the CDN
		// serves most polls without an origin hit, and stale-while-revalidate
		// keeps the ticker instant while it refreshes in the background. The feed
		// is a delight layer, so this much staleness is invisible — and it keeps
		// the Upstash request quota from being drained by idle open tabs.
		{ 'cache-control': 'public, s-maxage=20, stale-while-revalidate=60' },
	);
});

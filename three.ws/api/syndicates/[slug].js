// GET /api/syndicates/:slug
// ---------------------------------------------------------------------------
// One syndicate's public page: identity and flag, its leaders with their whole
// closed record and copyable verdict, the roster (usernames only; never a
// wallet or a size), the group equity curve from members' real acted copies,
// what the leaders did on-chain since founding, and its standing on the profit
// board with the rival one rank away. The signed-in viewer's own membership
// lives at GET /api/syndicates/membership, so this stays cacheable.

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { loadSyndicate, slugifyName } from '../_lib/syndicates.js';

/** The slug is the path segment; route params win over the query string. */
export function syndicateSlugFromRequest(req) {
	const fromRoute = req?.query?.slug;
	let raw = typeof fromRoute === 'string' && fromRoute ? fromRoute : '';
	if (!raw) {
		const segments = new URL(req?.url || '/', 'http://x').pathname.split('/').filter(Boolean);
		try {
			raw = decodeURIComponent(segments[segments.length - 1] || '');
		} catch {
			return null;
		}
	}
	const slug = String(raw).toLowerCase();
	return slugifyName(slug) === slug ? slug : null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const slug = syndicateSlugFromRequest(req);
	if (!slug) return error(res, 400, 'invalid_slug', 'That is not a syndicate address.');

	const data = await loadSyndicate(slug);
	if (!data) return error(res, 404, 'not_found', 'No syndicate flies that name.');

	res.setHeader?.('cache-control', 'public, max-age=20, s-maxage=30');
	return json(res, 200, { ...data, custody: 'none' });
});

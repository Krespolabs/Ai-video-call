// Syndicates board and founding.
// ---------------------------------------------------------------------------
//   GET  /api/syndicates?network=mainnet&sort=profit|members|new&limit=24&offset=0[&leader=<agent id>]
//        The public board: every active syndicate with its roster size, its group
//        performance from members' real copy intents, and what its leaders did
//        on-chain since it formed. While the board is empty the response also
//        carries `candidates`: the leaders a first syndicate could form around
//        today, each with its whole closed record and copyable verdict.
//        `leader` narrows the board to syndicates following that agent (ranks stay
//        board-wide), which is what /trader/:id shows.
//
//   POST /api/syndicates  { name, motto?, color, network?, leader_agent_ids: [..1-3] }
//        Found a syndicate (auth + CSRF for cookie sessions). Every leader must
//        be a public trader that clears the copyable bar. Founding does not
//        subscribe anyone: members join with their own wallet and caps through
//        POST /api/syndicates/membership.
//
// Non-custodial and additive over the copy loop: see api/_lib/syndicates.js.

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { BOARD_SORTS, SYNDICATE_COLORS, MAX_SYNDICATE_LEADERS, createSyndicate, loadBoard, loadFoundingCandidates } from '../_lib/syndicates.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'GET') {
		const q = new URL(req.url, 'http://x').searchParams;
		const network = NETWORKS.has(q.get('network')) ? q.get('network') : 'mainnet';
		const sort = BOARD_SORTS.includes(q.get('sort')) ? q.get('sort') : 'profit';
		const limit = Math.min(100, Math.max(1, parseInt(q.get('limit') || '24', 10) || 24));
		const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
		const leader = (q.get('leader') || '').trim();
		if (leader && !isUuid(leader)) return error(res, 400, 'invalid_leader', 'leader must be an agent UUID');

		const board = await loadBoard({ network, sort, limit, offset, leaderId: leader || null });
		const wantCandidates = !leader && (board.total === 0 || q.get('include') === 'candidates');
		const candidates = wantCandidates ? await loadFoundingCandidates(network, { limit: 12 }) : null;

		res.setHeader?.('cache-control', 'public, max-age=30, s-maxage=60');
		return json(res, 200, {
			...board,
			colors: SYNDICATE_COLORS,
			max_leaders: MAX_SYNDICATE_LEADERS,
			custody: 'none',
			...(candidates ? { candidates } : {}),
		});
	}

	// POST: found a syndicate.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'Sign in to start a syndicate.');
	const userId = session?.id ?? bearer.userId;
	if (session && !(await requireCsrf(req, res, userId))) return;

	const body = await readJson(req).catch(() => null);
	if (!body || typeof body !== 'object') return error(res, 400, 'bad_request', 'JSON body required');

	const result = await createSyndicate({ userId, input: body });
	if (!result.ok) return error(res, result.status, result.code, result.message, result.extra);
	return json(res, 201, { syndicate: result.syndicate, official: result.official });
});

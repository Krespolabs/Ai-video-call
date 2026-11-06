import { sql } from '../_lib/db.js';
import { cors, json, error, wrap, method } from '../_lib/http.js';
import { isUuid } from '../_lib/validate.js';
import { getSessionUser } from '../_lib/auth.js';
import { enrichLikes } from '../_lib/bounty-likes.js';

export default wrap(async (req, res) => {
	if (cors(req, res)) return;
	if (!method(req, res, ['GET'])) return;

	const id = req.query?.id || req.url?.split('/').pop()?.split('?')[0];
	if (!id) return error(res, 400, 'bad_request', 'bounty id required');
	// Non-UUID segments (scanner junk, or sibling routes like /leaderboard that
	// resolve here when their own file is missing) must not reach a uuid-typed
	// query — that throws NeonDbError and 500s. Treat non-uuid ids as not found.
	if (!isUuid(id)) return error(res, 404, 'not_found', 'bounty not found');

	const [bounty] = await sql`
		SELECT b.*,
		       COALESCE(
		         json_agg(
		           json_build_object(
		             'id', bs.id, 'user_id', bs.user_id, 'username', bs.username,
		             'content', bs.content, 'media_url', bs.media_url,
		             'media_type', bs.media_type, 'status', bs.status,
		             'reward_sol', bs.reward_sol, 'created_at', bs.created_at
		           ) ORDER BY bs.created_at DESC
		         ) FILTER (WHERE bs.id IS NOT NULL),
		         '[]'
		       ) AS submissions
		FROM bounties b
		LEFT JOIN bounty_submissions bs ON bs.bounty_id = b.id AND bs.status != 'rejected'
		WHERE b.id = ${id} AND b.deleted_at IS NULL
		GROUP BY b.id
	`;

	if (!bounty) return error(res, 404, 'not_found', 'bounty not found');

	const userId = (await getSessionUser(req).catch(() => null))?.id || null;
	await enrichLikes(bounty.submissions, { userId });

	return json(res, 200, { bounty });
});

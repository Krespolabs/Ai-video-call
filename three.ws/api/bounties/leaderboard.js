// GET /api/bounties/leaderboard — top earners and top spenders on the bounty
// board, consumed by /go (src/go.js → loadLeaderboards).
//
//   earners  — users who won accepted bounty submissions, ranked by total USD
//   spenders — users who posted resolved (closed) bounties, ranked by total USD
//
// USD figures come from bounties.reward_usd; a bounty with no reward_usd set
// still counts toward payout_count but contributes $0, which is correct — the
// board ranks realised value, not promised value.

import { sql } from '../_lib/db.js';
import { cors, json, wrap, method } from '../_lib/http.js';

const LIMIT = 10;

export default wrap(async (req, res) => {
	if (cors(req, res)) return;
	if (!method(req, res, ['GET'])) return;

	const [earners, spenders] = await Promise.all([
		sql`
			SELECT bs.user_id,
			       MAX(bs.username)                  AS username,
			       COUNT(*)::int                     AS payout_count,
			       COALESCE(SUM(b.reward_usd), 0)::float AS total_usd
			FROM bounty_submissions bs
			JOIN bounties b ON b.id = bs.bounty_id AND b.deleted_at IS NULL
			WHERE bs.status = 'accepted'
			GROUP BY bs.user_id
			ORDER BY total_usd DESC, payout_count DESC
			LIMIT ${LIMIT}
		`,
		sql`
			SELECT b.user_id,
			       MAX(b.username)                   AS username,
			       COUNT(*)::int                     AS payout_count,
			       COALESCE(SUM(b.reward_usd), 0)::float AS total_usd
			FROM bounties b
			WHERE b.status = 'closed' AND b.deleted_at IS NULL
			GROUP BY b.user_id
			ORDER BY total_usd DESC, payout_count DESC
			LIMIT ${LIMIT}
		`,
	]);

	res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { earners, spenders });
});

// Submission "likes" — read-side enrichment for the /go bounty board.
//
// Counts are computed on read (not denormalised) so the only schema this needs
// is the bounty_submission_likes table. Crucially this is ADDITIVE and
// resilient: if the table doesn't exist yet (migration not applied) or any
// query errors, rows degrade to like_count=0 / liked_by_me=false instead of
// breaking the feed. That lets the likes feature ship without a coordinated
// migrate-then-deploy.

import { sql } from './db.js';

// Mutates `rows` in place, attaching `like_count` (int) and `liked_by_me`
// (bool) to each, and returns the same array. `idField` is the property on
// each row holding the submission id. `userId` may be null for anonymous
// callers (then liked_by_me is always false).
export async function enrichLikes(rows, { idField = 'id', userId = null } = {}) {
	if (!Array.isArray(rows) || rows.length === 0) return rows;

	const ids = [...new Set(rows.map((r) => r?.[idField]).filter(Boolean))];
	if (!ids.length) return rows;

	try {
		const countRows = await sql`
			SELECT submission_id, COUNT(*)::int AS c
			FROM bounty_submission_likes
			WHERE submission_id = ANY(${ids}::uuid[])
			GROUP BY submission_id
		`;
		const counts = new Map(countRows.map((r) => [r.submission_id, r.c]));

		let liked = new Set();
		if (userId) {
			const mine = await sql`
				SELECT submission_id
				FROM bounty_submission_likes
				WHERE user_id = ${userId} AND submission_id = ANY(${ids}::uuid[])
			`;
			liked = new Set(mine.map((r) => r.submission_id));
		}

		for (const r of rows) {
			const sid = r?.[idField];
			r.like_count = counts.get(sid) || 0;
			r.liked_by_me = liked.has(sid);
		}
	} catch {
		// Table missing (pre-migration) or a transient error — degrade gracefully.
		for (const r of rows) {
			if (r.like_count == null) r.like_count = 0;
			r.liked_by_me = false;
		}
	}

	return rows;
}

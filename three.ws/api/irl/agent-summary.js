/**
 * IRL Agent Summary — one round-trip the owner dashboard (C1) paints from.
 *
 * GET /api/irl/agent-summary?mine=1   (auth required)
 *   Returns one row per owned pin, joined to its agent identity and derived
 *   activity, so the overview card renders without N blocking calls. Balance is
 *   hydrated separately (per-agent /api/agents/:id/solana) so first paint is fast.
 *
 * Returns { agents: [ {
 *   pin_id, agent_id, lat, lng, heading, caption, avatar_url, avatar_name,
 *   avatar_manifest, avatar_base_url, avatar_version,
 *   placed_at, expires_at, view_count, agent_name, solana_address,
 *   interaction_count, last_interaction_at, status
 * } ] }
 *
 * avatar_manifest/avatar_base_url/avatar_version (C6) let the dashboard open the
 * remote Outfit editor seeded with the pin's current look and detect re-skins.
 *
 * `status` is derived: 'expired' (expires_at passed) · 'online' (an interaction
 * touched the pin in the last 5 min — proxy until D1/C4 write last_seen_at) ·
 * 'visible' (live, no recent activity). Degrades to 0 / null when the
 * irl_interactions table (C4) isn't created yet — never 500s.
 */

import { cors, json, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export default wrap(async (req, res) => {
	cors(req, res, { methods: ['GET', 'OPTIONS'] });
	if (req.method === 'OPTIONS') return res.end();
	if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

	const session = await getSessionUser(req).catch(() => null);
	if (!session) return json(res, 401, { error: 'not authenticated' });

	// Table-existence guards so a fresh DB (or pre-C4 deploy) degrades instead of 500ing.
	const [reg] = await sql`
		SELECT to_regclass('irl_pins')         IS NOT NULL AS has_pins,
		       to_regclass('irl_interactions') IS NOT NULL AS has_ix
	`;
	if (!reg?.has_pins) return json(res, 200, { agents: [] });

	// Join interaction activity only when that table exists yet (C4). The two
	// query forms are explicit because Neon's driver doesn't splice sql fragments.
	const rows = reg.has_ix
		? await sql`
			SELECT p.id AS pin_id, p.agent_id, p.lat, p.lng, p.heading, p.caption,
			       p.avatar_url, p.avatar_name, p.placed_at, p.expires_at, p.view_count,
			       p.avatar_manifest, p.avatar_base_url, p.avatar_version,
			       p.placement_kind, p.fuzz_radius_m,
			       a.name AS agent_name,
			       a.meta->>'solana_address' AS solana_address,
			       COALESCE(ix.total, 0)::int AS interaction_count,
			       ix.last_at AS last_interaction_at
			FROM irl_pins p
			LEFT JOIN agent_identities a ON a.id = p.agent_id AND a.deleted_at IS NULL
			LEFT JOIN (
				SELECT pin_id, COUNT(*)::int AS total, MAX(created_at) AS last_at
				FROM irl_interactions GROUP BY pin_id
			) ix ON ix.pin_id = p.id
			WHERE p.user_id = ${session.id}
			ORDER BY p.placed_at DESC
			LIMIT 100`
		: await sql`
			SELECT p.id AS pin_id, p.agent_id, p.lat, p.lng, p.heading, p.caption,
			       p.avatar_url, p.avatar_name, p.placed_at, p.expires_at, p.view_count,
			       p.avatar_manifest, p.avatar_base_url, p.avatar_version,
			       p.placement_kind, p.fuzz_radius_m,
			       a.name AS agent_name,
			       a.meta->>'solana_address' AS solana_address,
			       0 AS interaction_count,
			       NULL AS last_interaction_at
			FROM irl_pins p
			LEFT JOIN agent_identities a ON a.id = p.agent_id AND a.deleted_at IS NULL
			WHERE p.user_id = ${session.id}
			ORDER BY p.placed_at DESC
			LIMIT 100`;

	const now = Date.now();
	const agents = rows.map((r) => {
		const expired = r.expires_at && new Date(r.expires_at).getTime() <= now;
		const lastMs  = r.last_interaction_at ? new Date(r.last_interaction_at).getTime() : 0;
		const online  = !expired && lastMs > 0 && now - lastMs < ONLINE_WINDOW_MS;
		return { ...r, status: expired ? 'expired' : online ? 'online' : 'visible' };
	});

	return json(res, 200, { agents });
});

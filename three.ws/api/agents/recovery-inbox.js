// GET /api/agents/recovery-inbox — the guardian's cross-agent console.
//
// Lists every agent the signed-in user is trusted to help recover (as a guardian)
// or will inherit (as a beneficiary), each decorated with the live recovery/
// inheritance process if one is open and whether this viewer still needs to act.
// This is the surface a guardian uses to approve a recovery or confirm an
// inheritance — they are not the owner, so they never see the owner-only hub tab.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, rateLimited, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { decorateRequest, getActiveRequest, getRecoveryConfig } from '../_lib/agent-recovery.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.walletRead(auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	// Agents where I hold an active guardian/beneficiary role.
	const rows = await sql`
		SELECT g.agent_id, g.role, g.created_at,
		       a.name AS agent_name, a.avatar_url, a.user_id AS owner_id, a.meta,
		       ou.username AS owner_username, ou.display_name AS owner_display_name
		FROM agent_recovery_guardians g
		JOIN agent_identities a ON a.id = g.agent_id AND a.deleted_at IS NULL
		JOIN users ou ON ou.id = a.user_id
		WHERE g.guardian_user_id = ${auth.userId} AND g.status = 'active'
		ORDER BY g.created_at DESC
	`;

	// Collapse rows per agent (a user can be both guardian and beneficiary).
	const byAgent = new Map();
	for (const r of rows) {
		if (!byAgent.has(r.agent_id)) {
			byAgent.set(r.agent_id, {
				agent_id: r.agent_id,
				agent_name: r.agent_name,
				avatar_url: r.avatar_url || null,
				owner: { id: r.owner_id, label: r.owner_display_name || (r.owner_username ? `@${r.owner_username}` : 'the owner') },
				meta: r.meta,
				roles: new Set(),
				since: r.created_at,
			});
		}
		byAgent.get(r.agent_id).roles.add(r.role);
	}

	const items = [];
	let actionable = 0;
	for (const a of byAgent.values()) {
		const activeRaw = await getActiveRequest(a.agent_id);
		const active = activeRaw ? await decorateRequest(activeRaw, a.agent_id) : null;
		const isGuardian = a.roles.has('guardian');
		const isBeneficiary = a.roles.has('beneficiary');

		// Does this viewer still need to act on the open process?
		let needsAction = false;
		if (active && ['pending_approvals', 'time_locked', 'ready'].includes(active.status)) {
			const alreadyVoted = active.votes?.some((v) => v.user_id === auth.userId);
			if (active.kind === 'recovery' && isGuardian && active.requester_id !== auth.userId && !alreadyVoted) needsAction = true;
			if (active.kind === 'inheritance' && (isGuardian || isBeneficiary) && !alreadyVoted && active.needs_beneficiary_confirmation && isBeneficiary) needsAction = true;
			if (active.kind === 'inheritance' && isGuardian && !alreadyVoted) needsAction = true;
		}
		if (needsAction) actionable++;

		const config = getRecoveryConfig(a.meta);
		items.push({
			agent_id: a.agent_id,
			agent_name: a.agent_name,
			avatar_url: a.avatar_url,
			owner: a.owner,
			roles: [...a.roles],
			since: a.since,
			active_request: active,
			needs_action: needsAction,
			dead_man_enabled: config.dead_man.enabled,
		});
	}
	// Sort: agents needing action first, then those with an open process, then rest.
	items.sort((x, y) => (y.needs_action - x.needs_action) || ((y.active_request ? 1 : 0) - (x.active_request ? 1 : 0)));

	return json(res, 200, { data: { items, actionable, count: items.length } });
});

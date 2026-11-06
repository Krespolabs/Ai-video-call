// /api/agents/:id/activate
//   GET  — owner-only activation status (which "Go Live" state to render)
//   POST — claim the one-time on-chain welcome grant (the activation faucet)
//
// Activation funds the agent's custodial wallet with a small, real, one-time SOL
// grant from the platform treasury and records it as a genuine tip custody event,
// so the agent immediately becomes a funded + active wallet on the Money Pulse.
// See api/_lib/agent-activation.js for the full rationale and guarantees.

import { sql } from '../../_lib/db.js';
import {
	getSessionUser,
	authenticateBearer,
	extractBearer,
	hasScope,
} from '../../_lib/auth.js';
import { cors, json, method, error, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { activateAgent, getActivationStatus } from '../../_lib/agent-activation.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session', scope: null };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, source: 'bearer', scope: bearer.scope || '' };
	return null;
}

export default async function handler(req, res, id) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a bearer token');

	// Bearer callers mutate the agent, so they need the avatars:write scope (session
	// cookie callers are not scope-constrained — they're the agent's human owner).
	if (req.method === 'POST' && auth.source === 'bearer' && !hasScope(auth.scope, 'avatars:write')) {
		return error(res, 403, 'insufficient_scope', 'avatars:write required');
	}

	const [agent] = await sql`
		select id, user_id, name, meta from agent_identities
		where id = ${id} and deleted_at is null limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	const isOwner = agent.user_id === auth.userId;

	if (req.method === 'GET') {
		// Status is an owner-only signal (it drives owner onboarding UI); a visitor
		// gets the inert, not-eligible shape rather than the owner's reasons.
		const status = await getActivationStatus({
			agent: { id: agent.id, meta: agent.meta, solana_address: agent.meta?.solana_address },
			isOwner,
		});
		return json(res, 200, { data: status });
	}

	// POST — perform activation.
	if (!isOwner) return error(res, 403, 'forbidden', 'not your agent');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const result = await activateAgent({ agentId: id, userId: auth.userId });
	if (result.ok) return json(res, 200, { data: result });

	const STATUS = {
		not_found: 404,
		forbidden: 403,
		platform_agent: 409,
		not_configured: 503,
		cap_reached: 429,
		treasury_low: 503,
		wallet_unavailable: 503,
		transfer_failed: 502,
	};
	const code = result.code || 'activation_failed';
	return error(res, STATUS[code] || 400, code, result.message || 'activation failed');
}

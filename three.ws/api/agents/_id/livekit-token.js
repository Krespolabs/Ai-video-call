// Handler for GET /api/agents/:id/livekit-token
// Returns a short-lived LiveKit room access token for the given agent room.
// Requires auth (session or bearer). Uses jose to sign the JWT directly —
// livekit-server-sdk is not a project dependency.

import { SignJWT } from 'jose';
import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, error } from '../../_lib/http.js';
import { isUuid } from '../../_lib/validate.js';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_SERVER_URL = process.env.LIVEKIT_SERVER_URL;

export async function handleLiveKitToken(req, res, agentId) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_SERVER_URL) {
		return error(
			res,
			503,
			'livekit_not_configured',
			'LiveKit is not configured on this server',
		);
	}

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');

	const userId = session?.id ?? bearer.userId;

	if (!isUuid(String(agentId))) return error(res, 404, 'not_found', 'agent not found');

	// The token grants publish rights in the agent's room — only the agent's
	// owner may mint one, otherwise any signed-in user could broadcast into
	// (and listen to) any other agent's room.
	const [agent] = await sql`
		SELECT id FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const roomName = `agent-${agentId}`;
	const participantId = `user-${userId}`;

	const secret = new TextEncoder().encode(LIVEKIT_API_SECRET);
	const now = Math.floor(Date.now() / 1000);

	const token = await new SignJWT({
		video: {
			roomJoin: true,
			room: roomName,
			canPublish: true,
			canSubscribe: true,
		},
		sub: participantId,
		iss: LIVEKIT_API_KEY,
		nbf: now,
		exp: now + 3600,
	})
		.setProtectedHeader({ alg: 'HS256' })
		.sign(secret);

	return json(res, 200, { token, serverUrl: LIVEKIT_SERVER_URL });
}

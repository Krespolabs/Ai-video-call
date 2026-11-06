// The signed-in caller for /api/duels/*: a session cookie or a bearer token.
// Returns { userId, viaSession } or null. Never throws.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';

export async function duelCaller(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, viaSession: true };
	const bearer = await authenticateBearer(extractBearer(req));
	return bearer ? { userId: bearer.userId, viaSession: false } : null;
}

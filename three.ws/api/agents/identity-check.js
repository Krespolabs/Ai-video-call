// POST /api/agents/identity-check
// Body: { name?, description?, persona_tone_tags?: string[], agent_id?: string }
// -----------------------------------------------------------------------------
// The Granite identity-integrity gate, exposed for the agent editor to call
// before a user commits a new (or renamed) identity. It embeds the candidate
// with IBM Granite and cosine-compares it against every public agent — catching
// look-alikes a name match would miss — and screens the identity text with
// Granite Guardian. Returns a clear/review/block verdict with the nearest
// neighbours so the UI can warn "this resembles an existing agent" up front.
//
// Best-effort: when watsonx is unconfigured the verdict is { configured:false,
// status:'unavailable' } and the client treats the identity as allowed.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { checkIdentityIntegrity } from '../_lib/identity-integrity.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// Auth is optional. Signed-in callers also get their own agents compared (so
	// the editor can warn "you already have a similar agent"); anonymous callers
	// (e.g. the public IBM showcase) still get impersonation detection against
	// public agents plus Granite Guardian content screening. Best-effort resolve.
	const session = await getSessionUser(req).catch(() => null);
	const bearer = session ? null : await authenticateBearer(extractBearer(req)).catch(() => null);
	const userId = session?.id ?? bearer?.userId ?? null;

	const ip = clientIp(req);
	const [ipRl, globalRl] = await Promise.all([
		limits.identityCheckIp(ip),
		limits.identityCheckGlobal(),
	]);
	if (!ipRl.success || !globalRl.success) {
		return rateLimited(res, ipRl, 'too many identity checks; try again shortly');
	}

	let body;
	try {
		body = await readJson(req, 8_000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message || 'invalid JSON body');
	}

	const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
	const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';
	const tags = Array.isArray(body.persona_tone_tags)
		? body.persona_tone_tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
		: [];
	// Only honor excludeAgentId when the caller is authenticated — an unauthenticated
	// caller has no standing to exclude an arbitrary agent from the similarity check.
	const excludeAgentId =
		userId && typeof body.agent_id === 'string' && isUuid(body.agent_id) ? body.agent_id : null;

	if (!name && !description) {
		return error(res, 400, 'validation_error', 'name or description is required');
	}

	const result = await checkIdentityIntegrity(
		{ name, description, persona_tone_tags: tags },
		{ userId, excludeAgentId },
	);
	return json(res, 200, result);
});

export const maxDuration = 30;

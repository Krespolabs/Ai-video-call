// Avatar customization draft preview — ephemeral, capability-scoped.
//
// PUT /api/avatars/draft/:id   — owner stores an in-progress appearance under a
//                                client-generated, unguessable id. We resolve the
//                                avatar's BASE (unbaked) GLB server-side and cache
//                                { base_model_url, appearance, name } for an hour.
// GET /api/avatars/draft/:id   — the walk page reads the draft back (the id is the
//                                capability token) and renders the unsaved look.
//
// Why a server round-trip instead of cramming appearance into the URL: the walk
// page loads a *private* avatar's GLB, which needs a freshly presigned URL the
// editor client can't mint. Stashing the draft also keeps the deep-link short and
// lets the look survive a reload. Drafts are never persisted to the DB — they live
// in the cache (Redis with in-memory fallback) and expire.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../../_lib/auth.js';
import { getAvatar } from '../../_lib/avatars.js';
import { presignGet } from '../../_lib/r2.js';
import { cors, error, json, method, wrap, readJson, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { cacheGet, cacheSet } from '../../_lib/cache.js';
import { avatarAppearance, isUuid } from '../../_lib/validate.js';
import { z } from 'zod';

const DRAFT_TTL_SECONDS = 3600; // 1 hour — long enough to tweak + preview, short enough to forget
const URL_EXPIRES_IN = DRAFT_TTL_SECONDS; // keep the presigned GLB alive for the draft's lifetime

// Draft ids are client-minted (crypto.randomUUID / randomToken). Constrain the
// charset/length so the id can't smuggle a `:` into the cache key namespace.
const DRAFT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

const putSchema = z.object({
	avatar_id: z.string().refine(isUuid, 'invalid avatar id'),
	appearance: avatarAppearance.nullable().optional(),
});

function draftKey(id) {
	return `avatar-draft:${id}`;
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer && hasScope(bearer.scope, 'avatars:write')) {
		return { userId: bearer.userId, source: 'bearer' };
	}
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PUT,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT'])) return;

	const id = req.query?.id || new URL(req.url, 'http://x').pathname.split('/').pop();
	if (!id || !DRAFT_ID_RE.test(id)) {
		return error(res, 400, 'invalid_request', 'invalid draft id');
	}

	if (req.method === 'GET') {
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		const draft = await cacheGet(draftKey(id));
		if (!draft) return error(res, 404, 'not_found', 'draft not found or expired');
		// Surface only what the walk page needs — never the owner id or storage key.
		return json(res, 200, {
			draft: {
				base_model_url: draft.base_model_url,
				appearance: draft.appearance || null,
				name: draft.name || 'Avatar',
			},
		});
	}

	// PUT — owner stores / refreshes the draft.
	const auth = await resolveAuth(req);
	if (!auth) {
		return error(res, 401, 'unauthorized', 'sign in or provide a token with avatars:write');
	}

	const rl = await limits.publicIp(`draft:${auth.userId}`);
	if (!rl.success) return rateLimited(res, rl);

	if (auth.source === 'session' && !(await requireCsrf(req, res, auth.userId))) return;

	const body = await readJson(req);
	const data = putSchema.safeParse(body);
	if (!data.success) {
		return error(res, 400, 'validation_error', data.error.issues[0]?.message || 'invalid draft', {
			issues: data.error.issues,
		});
	}

	const avatar = await getAvatar({ id: data.data.avatar_id, requesterId: auth.userId });
	if (!avatar) return error(res, 404, 'not_found', 'avatar not found');
	if (avatar.owner_id !== auth.userId) {
		return error(res, 403, 'forbidden', 'you do not own this avatar');
	}
	if (!avatar.storage_key) return error(res, 422, 'unprocessable', 'avatar has no model to preview');

	// Resolve the BASE (unbaked) GLB — the editor applies appearance client-side,
	// so loading the baked URL would double-stack outfits. Public/unlisted avatars
	// already carry a CDN base_model_url; private ones get a short-lived presign.
	const baseModelUrl =
		avatar.base_model_url || (await presignGet({ key: avatar.storage_key, expiresIn: URL_EXPIRES_IN }));

	await cacheSet(
		draftKey(id),
		{
			owner_id: auth.userId,
			avatar_id: avatar.id,
			name: avatar.name || 'Avatar',
			base_model_url: baseModelUrl,
			appearance: data.data.appearance || null,
		},
		DRAFT_TTL_SECONDS,
	);

	return json(res, 200, { ok: true, draft_id: id, expires_in: DRAFT_TTL_SECONDS });
});

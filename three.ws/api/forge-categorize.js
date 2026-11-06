/**
 * Forge categorize — set the model_category on a forge creation.
 *
 *   POST /api/forge-categorize   { creation_id, model_category }
 *
 * Auth-free like the rest of /forge: scoped to the anonymous client key
 * (x-forge-client header) so a creator can only categorize their own models.
 *
 * Valid categories: avatar | accessory | item | scene | creature | vehicle | other
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { hashClient, setForgeCategory, MODEL_CATEGORIES, forgeStoreEnabled } from './_lib/forge-store.js';
import { isUuid } from './_lib/validate.js';

const VALID_CATEGORIES = new Set(MODEL_CATEGORIES);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (!forgeStoreEnabled()) {
		return json(res, 200, { ok: false, stored: false, reason: 'persistence_unconfigured' });
	}

	const body = await readJson(req, 4_000).catch(() => null);
	const creationId = typeof body?.creation_id === 'string' ? body.creation_id.trim() : '';
	if (!isUuid(creationId)) {
		return json(res, 400, { error: 'invalid_creation', message: 'creation_id must be a uuid.' });
	}

	const modelCategory = typeof body?.model_category === 'string' ? body.model_category.trim() : '';
	if (!VALID_CATEGORIES.has(modelCategory)) {
		return json(res, 400, {
			error: 'invalid_category',
			message: `model_category must be one of: ${MODEL_CATEGORIES.join(', ')}`,
		});
	}

	const rawClient = req.headers['x-forge-client'];
	const clientKey = hashClient(Array.isArray(rawClient) ? rawClient[0] : rawClient);

	const stored = await setForgeCategory({ id: creationId, clientKey, modelCategory });

	return json(res, 200, { ok: true, stored });
});

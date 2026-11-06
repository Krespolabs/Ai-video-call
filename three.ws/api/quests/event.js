// POST /api/quests/event  { kind: 'ghost_copy', leader_agent_id, network?, context? }
// ---------------------------------------------------------------------------
// Records the one quest event the server cannot see on its own: a ghost-copy
// replay. The replay endpoint is public, stateless and CDN-cached, so the page
// reports a finished replay here, signed in. Only the FIRST ghost of a leader
// is kept (that is what "ghost-copy a new agent" means), the leader must be a
// public agent with closed trades, and it is paper-only, so nothing here is
// worth more than XP. The same event completes step 2 of the first-copy path
// (api/_lib/copy-path.js), which had no writer before this.

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { recordGhostQuest } from '../_lib/trading-quests.js';
import { recordCopyPathStep, sanitizeStepContext } from '../_lib/copy-path.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;
	if (session && !(await requireCsrf(req, res, userId))) return;

	const body = await readJson(req).catch(() => null);
	if (!body || typeof body !== 'object') return error(res, 400, 'bad_request', 'JSON body required');
	if (body.kind !== 'ghost_copy') return error(res, 400, 'invalid_kind', "kind must be 'ghost_copy'");

	const network = NETWORKS.has(body.network) ? body.network : 'mainnet';
	const context = sanitizeStepContext('ghost', { ...(body.context || {}), leader_agent_id: body.leader_agent_id });
	const result = await recordGhostQuest({ userId, leaderId: body.leader_agent_id, network, context });
	if (!result.ok) return error(res, 400, 'invalid_leader', result.error);

	if (context) await recordCopyPathStep(userId, 'ghost', context).catch(() => false);
	return json(res, 200, { recorded: true, new_agent: result.new_agent });
});

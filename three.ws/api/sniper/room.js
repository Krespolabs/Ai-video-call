/**
 * Live trade room: one leader's snapshot.
 *
 *   GET /api/sniper/room?agent_id=<uuid>&network=mainnet
 *
 * Everything the /trade-rooms/:id page paints before its live stream attaches:
 * the leader (name, image, and their public 3D body when it has one), the
 * room's liveliness and spectator count, 30-day headline stats from the shared
 * trader-stats truth layer, open positions with live unrealized P&L, and the
 * latest buys and sells (each linked to its Solscan tx and, once closed, its
 * /trade/:id card). The live stream is /api/sniper/room-stream.
 *
 * Public + IP rate-limited, with the same visibility gate as
 * /api/sniper/trader: a private or deleted agent has no room (404).
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import { loadRoom } from '../_lib/trade-room.js';
import { countSpectators } from '../_lib/trade-room-presence.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const agentId = (params.get('agent_id') || params.get('agent') || '').trim();
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	if (!isUuid(agentId)) return error(res, 400, 'invalid_agent', 'agent_id must be a valid agent UUID');

	const spectators = await countSpectators(agentId);
	const room = await loadRoom({ agentId, network, spectators });
	if (!room) return error(res, 404, 'not_found', 'No such trader, or it is not public.');

	return json(res, 200, room, { 'cache-control': 'public, max-age=5, s-maxage=10' });
});

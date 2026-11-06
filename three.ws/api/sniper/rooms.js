/**
 * Live trade rooms: the lobby.
 *
 *   GET /api/sniper/rooms?network=mainnet&limit=24
 *
 * Every public leader with a real fill in the last 90 days (or a position open
 * right now), ranked live first, then by spectators, then by recency. Each row
 * carries the room's liveliness, when the leader last traded, their 24h fill
 * count and 7-day realized P&L from the sniper ledger, and how many people are
 * watching. Powers /trade-rooms and the "other rooms" rail inside a room.
 *
 * Public + IP rate-limited. Shape and ranking live in api/_lib/trade-room.js.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { listRooms } from '../_lib/trade-room.js';
import { countSpectatorsMany } from '../_lib/trade-room-presence.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const limit = Math.max(1, Math.min(60, Number(params.get('limit')) || 24));

	const rooms = await listRooms({ network, limit, spectatorCounts: countSpectatorsMany });
	return json(res, 200, { network, rooms, t: Date.now() }, { 'cache-control': 'public, max-age=10, s-maxage=15' });
});

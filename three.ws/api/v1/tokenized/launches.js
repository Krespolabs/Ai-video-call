// GET /api/v1/tokenized/launches?limit=24&offset=0&network=mainnet&agent_id=<uuid>
//
// Free, public, paginated feed of every generated 3D asset minted as a
// Metaplex Core NFT THROUGH three.ws (a `tokenized_3d_assets` row) — the NFT
// analogue of GET /api/v1/pump/launches (coins launched through three.ws).
// Registered under the versioned, cataloged /api/v1 surface so agents can
// discover three.ws's own tokenized-3D launch history via GET /api/v1.
//
// The query lives in api/_lib/tokenized-launches.js `queryTokenizedLaunches`
// so a future agent-profile "minted 3D assets" card can share it, exactly the
// way the pump-launches directory is shared today.

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { isUuid } from '../../_lib/validate.js';
import { queryTokenizedLaunches } from '../../_lib/tokenized-launches.js';

const MAX_LIMIT = 100;

export default defineEndpoint({
	name: 'v1.tokenized.launches',
	method: 'GET',
	auth: 'public',
	handler: async ({ req, res, query }) => {
		// Same dedicated-shared budget as the sibling free /api/v1 reads — this
		// hits the database on a cache miss, so it caps a scripted enumeration flood.
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'tokenized launches is capped at 60 requests/min per IP');

		const rawLimit = Number(query.limit);
		const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 24));
		const rawOffset = Number(query.offset);
		const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);
		const network = query.network === 'devnet' ? 'devnet' : 'mainnet';

		const agentId = typeof query.agent_id === 'string' ? query.agent_id.trim() : '';
		if (agentId && !isUuid(agentId)) fail(400, 'validation_error', 'agent_id must be a uuid');

		const { launches, has_more } = await queryTokenizedLaunches({
			network,
			agentId: agentId || null,
			offset,
			limit,
		});

		// Fresh mints land continuously; a short CDN window keeps polling agents
		// current without hammering the database.
		res.setHeader('cache-control', 'public, max-age=15, s-maxage=15');
		return { launches, has_more, offset, limit, network };
	},
});

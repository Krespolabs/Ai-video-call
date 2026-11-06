// GET /api/bnb/world-config?network=testnet|mainnet
// ---------------------------------------------------------------------------
// Public (non-secret) config for prompt 16's on-chain presence mode
// (src/agora/onchain-presence.js). A deployed contract address is not a
// secret — only the deployer key is — so this is a plain cached GET, no auth,
// mirroring api/bnb/babt-check.js's shape. Exists so the browser never needs
// its own copy of WORLD_MOVES_ADDRESS_TESTNET/MAINNET (which live in the
// SERVER's env, unreachable from client code) and so flipping the env var the
// moment a real public deploy lands (contracts/DEPLOYMENTS.md) takes effect
// for every open browser tab without a frontend rebuild.
//
// Response: { network, chainId, address, deployed, explorer, rpcs, worldId }
// `address: null, deployed: false` is a normal, honest state (00-CONTEXT:
// never fabricate a live-looking address) — the client renders "not deployed
// yet" and never fires a wallet prompt for a contract that doesn't exist.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { BNB_CHAINS } from '../_lib/bnb/chains.js';
import { worldMovesAddress, WorldMovesError } from '../_lib/bnb/world-moves.js';

// Single logical "world" for the Agora Commons on-chain presence layer today
// (see src/agora/onchain-presence.js) — multi-world routing is out of scope
// for this campaign; bumping this would fragment presence for every existing
// player, so treat it as a stable public constant, not a per-request input.
const COMMONS_WORLD_ID = 1;

function normalizeNetworkParam(raw) {
	const v = String(raw || '').trim().toLowerCase();
	if (v === 'testnet' || v === '97' || v === 'bsctestnet') return 'bscTestnet';
	if (v === '' || v === 'mainnet' || v === '56' || v === 'bscmainnet') return 'bscMainnet';
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const network = normalizeNetworkParam(params.get('network'));
	if (network === null) {
		return error(res, 400, 'bad_request', `unknown network "${params.get('network')}" — use "mainnet" or "testnet"`);
	}

	const meta = BNB_CHAINS[network];
	let address = null;
	try {
		address = worldMovesAddress(network);
	} catch (err) {
		if (!(err instanceof WorldMovesError)) throw err;
		// no_deployment is the expected, honest state until a public deploy lands.
	}

	return json(
		res,
		200,
		{
			network,
			chainId: meta.id,
			address,
			deployed: !!address,
			explorer: meta.explorer,
			rpcs: meta.rpcs,
			worldId: COMMONS_WORLD_ID,
		},
		{ 'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' },
	);
});

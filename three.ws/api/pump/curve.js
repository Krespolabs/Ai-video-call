// GET /api/pump/curve?mint=<mint>[&network=mainnet|devnet]
// ----------------------------------------------------------
// Public, read-only bonding-curve view. Combines @nirholas/pump-sdk reads via
// our RpcFallback + sdk-bridge helpers and returns:
//   - bonding curve raw state
//   - current price + market cap
//   - graduation progress
//
// The fetch/RPC/Jupiter-fallback logic lives in api/_lib/pump-curve-view.js
// (getCurveView), shared with the free GET /api/v1/pump/curve endpoint — one
// path, two doors, byte-identical response shape and cache headers.

import { cors, json, method, wrap, error } from '../_lib/http.js';
import { getCurveView, isPlausibleMint } from '../_lib/pump-curve-view.js';

function readMint(req) {
	try {
		const u = new URL(req.url, 'http://x');
		return {
			mint: (u.searchParams.get('mint') || '').trim(),
			network: u.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet',
		};
	} catch {
		return { mint: '', network: 'mainnet' };
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const { mint, network } = readMint(req);
	if (!mint || !isPlausibleMint(mint)) {
		return error(res, 400, 'bad_mint', 'mint query param must be a base58 Solana address');
	}

	const { httpStatus, cacheControl, body } = await getCurveView({ mint, network });
	return json(res, httpStatus, body, cacheControl ? { 'cache-control': cacheControl } : {});
});

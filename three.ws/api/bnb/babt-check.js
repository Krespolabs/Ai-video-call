// GET /api/bnb/babt-check?address=0x...&network=mainnet|testnet
// ---------------------------------------------------------------------------
// Free BABT (Binance Account Bound Token) holder check — a real, on-chain,
// KYC-backed uniqueness signal on BSC. Verified real + third-party-queryable
// 2026-07-08 (docs/bnb-babt-findings.md has the full research writeup + live
// probes). One `eth_call` to a verified public contract; no API key needed.
//
// Response: { address, network, holdsBabt, tokenId, contract, explorer, checkedAt }
// `network` defaults to mainnet, where the real 1.16M+ KYC'd holder base
// lives — pass `network=testnet` only to exercise integration code; testnet
// mints are real but are developer accounts, not KYC'd Binance users.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { hasBabt, BabtCheckError } from '../_lib/bnb/babt.js';
import { isEvmAddress, BNB_CHAINS } from '../_lib/bnb/chains.js';

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
	const address = params.get('address') || '';
	const networkParam = params.get('network');

	if (!address) {
		return error(res, 400, 'bad_request', 'address query param is required (0x-prefixed BSC/EVM address)');
	}
	if (!isEvmAddress(address)) {
		return error(res, 400, 'bad_request', `not a valid BSC/EVM address: ${address.slice(0, 64)}`);
	}
	const network = normalizeNetworkParam(networkParam);
	if (network === null) {
		return error(res, 400, 'bad_request', `unknown network "${networkParam}" — use "mainnet" or "testnet"`);
	}

	try {
		const result = await hasBabt(address, network);
		const explorer = BNB_CHAINS[network].explorer;
		return json(
			res,
			200,
			{
				...result,
				explorer: `${explorer}/token/${result.contract}?a=${result.address}`,
				note:
					network === 'bscTestnet'
						? 'testnet BABT mints are real but belong to developers testing the mint flow, not KYC\'d Binance users — do not treat this as a sybil-resistance signal, only as an integration test.'
						: 'a true result means this address is bound to a Binance-identity-verified account right now; Binance can revoke and re-mint to a different wallet, so this is a point-in-time check, not a permanent identity anchor.',
			},
			{ 'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' },
		);
	} catch (err) {
		if (err instanceof BabtCheckError) {
			return error(res, 502, 'contract_unreachable', 'could not read the BABT contract right now — retry shortly', {
				network: err.network,
				contract: err.contract,
			});
		}
		if (err instanceof TypeError) {
			return error(res, 400, 'bad_request', err.message);
		}
		throw err;
	}
});

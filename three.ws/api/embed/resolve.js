/**
 * GET /api/embed/resolve?id=<spec>&gate_token=<token>
 *
 * Resolves a flexible ID spec to the minimal payload an embed needs to render
 * an agent: { glbUrl, name, poster, kind, ...minimal metadata }.
 *
 * Supported ID specs (kept tiny on purpose):
 *   - "<chainId>:<agentId>"         → on-chain ERC-8004 agent  e.g. "8453:42"
 *   - "eip155:<chainId>:<agentId>"  → same, namespaced form    e.g. "eip155:8453:42"
 *   - "avatar:<uuid>"               → public avatar            e.g. "avatar:8e3...c1"
 *
 * Cross-origin by design (Access-Control-Allow-Origin: *). Cached aggressively
 * at the edge so an embed loading in 10k pages doesn't hammer the DB — EXCEPT
 * when the asset is token-gated (api/_lib/embed-gate.js), where the response
 * depends on the caller's own access token and must never be shared/cached.
 *
 * Token gating: when an asset carries an active embed_gates row, the real
 * glbUrl is withheld unless `gate_token` is a valid, unexpired access token
 * minted by api/embed/gate-verify.js for THIS asset's current gate. Without
 * one (or with an expired one) the response is a designed "locked" payload —
 * still 200, never an error — carrying the gate's public terms (mint,
 * minAmount) so the widget can render the locked state and prompt a wallet
 * connect + verify. Resolution logic lives in api/_lib/embed-asset.js so this
 * handler and the gate verifier resolve the exact same asset shape.
 */

import { cors, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { resolveEmbedAsset, isEmbedAssetRef } from '../_lib/embed-asset.js';
import { readEmbedGateByAsset, DEFAULT_GATE_MINT } from '../_lib/embed-gate.js';
import { verifyEmbedGateToken } from '../_lib/embed-gate-token.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const id = (url.searchParams.get('id') || '').trim();
	if (!id) return error(res, 400, 'validation_error', 'id is required');

	if (!isEmbedAssetRef(id)) {
		return error(
			res,
			400,
			'validation_error',
			'id must be "<chainId>:<agentId>", "eip155:<chainId>:<agentId>", or "avatar:<uuid>"',
		);
	}

	const payload = await resolveEmbedAsset(id);
	if (!payload) return error(res, 404, 'not_found', 'asset not found');

	const gate = await readEmbedGateByAsset(id);
	if (!gate) return embedJson(res, payload, { cacheable: true });

	const gateToken = (url.searchParams.get('gate_token') || '').trim();
	const claim = gateToken
		? await verifyEmbedGateToken(gateToken, { assetId: id, gateId: gate.id })
		: null;

	if (claim) {
		return embedJson(res, { ...payload, gated: true, unlocked: true }, { cacheable: false });
	}

	// Locked — never leak glbUrl. The teaser (name/poster) is the same public
	// metadata resolveEmbedAsset would return for an ungated asset, so a
	// visitor can see what they'd unlock without the payload leaking the model.
	const symbol = gate.mint === DEFAULT_GATE_MINT ? '$THREE' : shortMint(gate.mint);
	return embedJson(
		res,
		{
			kind: payload.kind,
			id: payload.id,
			name: payload.name,
			description: payload.description,
			poster: payload.poster,
			gated: true,
			locked: true,
			gate: {
				gateId: gate.id,
				mint: gate.mint,
				symbol,
				minAmount: Number(gate.min_amount),
				chain: gate.chain,
			},
		},
		{ cacheable: false },
	);
});

function shortMint(mint) {
	const s = String(mint || '');
	return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

function embedJson(res, payload, { cacheable }) {
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('cross-origin-resource-policy', 'cross-origin');
	res.setHeader(
		'cache-control',
		cacheable
			? 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400'
			: 'private, no-store',
	);
	res.end(JSON.stringify(payload));
}

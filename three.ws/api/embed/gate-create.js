// POST /api/embed/gate-create
//
// create_gated_embed(asset_id, gate) — turn an existing embeddable asset
// (avatar or on-chain agent) into a holder-only interactive 3D embed. The
// caller must own the asset; the gate config `{ mint, min_amount, chain }` is
// persisted alongside the embed record (embed_gates) and enforced server-side
// by api/embed/resolve.js on every subsequent fetch — this endpoint never
// hands back the glbUrl itself, only the gate + a ready-to-paste snippet.
//
// `mint` defaults to $THREE but is a runtime parameter — the coin-agnostic
// plumbing exception in CLAUDE.md — so any community can gate with their own
// SPL token. This endpoint never suggests or defaults to any other mint.
import { z } from 'zod';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { parse } from '../_lib/validate.js';
import { isEmbedAssetRef, resolveEmbedAsset } from '../_lib/embed-asset.js';
import { DEFAULT_GATE_MINT, createEmbedGate, checkAssetOwnership } from '../_lib/embed-gate.js';

const bodySchema = z.object({
	assetId: z.string().trim().min(3).max(80),
	gate: z.object({
		mint: z.string().trim().min(3).max(64).optional(),
		minAmount: z.number().positive(),
		chain: z.enum(['solana']).optional(),
	}),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required to gate an embed');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.embedGateCreateIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(bodySchema, await readJson(req));

	if (!isEmbedAssetRef(body.assetId)) {
		return error(
			res,
			400,
			'validation_error',
			'assetId must be "<chainId>:<agentId>", "eip155:<chainId>:<agentId>", or "avatar:<uuid>"',
		);
	}

	const asset = await resolveEmbedAsset(body.assetId);
	if (!asset) return error(res, 404, 'not_found', 'embed asset not found');

	const ownership = await checkAssetOwnership(body.assetId, userId);
	if (!ownership.ok) {
		if (ownership.reason === 'not_owner') {
			return error(
				res,
				403,
				'not_owner',
				'you do not own this asset — link the owning wallet (or account) to gate it',
			);
		}
		return error(res, 404, 'not_found', 'embed asset not found');
	}

	let gate;
	try {
		gate = await createEmbedGate({
			assetId: body.assetId,
			ownerUserId: userId,
			mint: body.gate.mint || DEFAULT_GATE_MINT,
			minAmount: body.gate.minAmount,
			chain: body.gate.chain || 'solana',
		});
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message);
	}

	const scriptSrc = `${env.APP_ORIGIN}/embed/v1.js`;
	const snippet =
		`<script src="${scriptSrc}" async></script>\n` +
		`<three-d agent="${body.assetId}" interactive></three-d>`;

	return json(res, 201, {
		gateId: gate.gateId,
		assetId: gate.assetId,
		gate: { mint: gate.mint, minAmount: gate.minAmount, chain: gate.chain },
		name: asset.name || null,
		embed: {
			scriptSrc,
			snippet,
			previewUrl: `${env.APP_ORIGIN}/embed/v1/gated.html?asset=${encodeURIComponent(body.assetId)}`,
		},
	});
});

// Tokenized-3D metadata + policy — the PURE core (no DB, no chain, no storage).
//
// This module owns the two things that must be provably correct in isolation:
//   1. The Metaplex-compliant metadata JSON for a 3D NFT — the GLB under
//      `animation_url` + `properties.files` (mimeType model/gltf-binary), the
//      thumbnail under `image`, the live viewer under `external_url`, and baked
//      provenance under `properties.provenance`.
//   2. The enforced-royalty hard cap.
// Both are unit-tested in tests/tokenize-3d.test.js without any network.
//
// $THREE-policy clean: $THREE is the only coin named in the copy/metadata. SOL
// (Core rent + royalty rail) is a settlement mechanic only; no other mint is
// ever hardcoded here — the $THREE mint comes from env via three-brand.js.

import { createHash } from 'node:crypto';

import { THREE_WS, threeTokenLinks } from './three-brand.js';

// ── Royalty policy ───────────────────────────────────────────────────────────

/**
 * Hard cap on the enforced secondary-sale royalty (10%). A caller asking for
 * more is clamped to this — the holder always keeps the clear majority of a
 * resale, and the platform never mints an asset that taxes the secondary market
 * beyond a sane ceiling. This is enforced twice: here (before the mint) and by
 * the CHECK constraint on tokenized_3d_assets.royalty_bps.
 */
export const TOKENIZE_3D_ROYALTY_CAP_BPS = 1000;

/** Default enforced royalty when the caller doesn't specify one (5%, to creator). */
export const TOKENIZE_3D_ROYALTY_DEFAULT_BPS = 500;

/**
 * Clamp a requested seller-fee to [0, cap]. Non-finite / negative → the default.
 * @param {number|string|null|undefined} bps
 * @returns {{ bps: number, capped: boolean, requestedBps: number }}
 */
export function clampSellerFeeBps(bps) {
	if (bps === null || bps === undefined || bps === '') {
		return { bps: TOKENIZE_3D_ROYALTY_DEFAULT_BPS, capped: false, requestedBps: TOKENIZE_3D_ROYALTY_DEFAULT_BPS };
	}
	const requested = Math.round(Number(bps));
	if (!Number.isFinite(requested) || requested < 0) {
		return { bps: TOKENIZE_3D_ROYALTY_DEFAULT_BPS, capped: false, requestedBps: TOKENIZE_3D_ROYALTY_DEFAULT_BPS };
	}
	const clamped = Math.min(requested, TOKENIZE_3D_ROYALTY_CAP_BPS);
	return { bps: clamped, capped: requested > TOKENIZE_3D_ROYALTY_CAP_BPS, requestedBps: requested };
}

// ── Idempotency ──────────────────────────────────────────────────────────────

/**
 * Deterministic idempotency key for a mint request. Same (owner, source,
 * network, creator) → same key → the claim-first guard collapses a double-call
 * onto one on-chain mint. Callers may override with their own key.
 *
 * @param {{ ownerWallet: string, glbSource: string, network: string, creatorUserId?: string|null }} p
 * @returns {string} 64-char hex
 */
export function deriveIdempotencyKey({ ownerWallet, glbSource, network, creatorUserId = null }) {
	return createHash('sha256')
		.update(`${network}\n${ownerWallet}\n${glbSource}\n${creatorUserId || ''}`)
		.digest('hex');
}

// ── Metadata ─────────────────────────────────────────────────────────────────

function clamp(str, max) {
	const s = String(str ?? '');
	return s.length > max ? s.slice(0, max) : s;
}

/**
 * Build the Metaplex-compliant off-chain metadata JSON for a tokenized 3D asset.
 * A strict superset of the Metaplex token-metadata standard so Phantom / Solscan
 * / Magic Eden render it, with `animation_url` = the rigged GLB so the NFT media
 * is a live 3D model, not a static PNG.
 *
 * @param {object} a
 * @param {string} a.name
 * @param {string} [a.description]
 * @param {string} a.glbUrl              durable GLB (https)
 * @param {string} a.imageUrl            durable thumbnail (https)
 * @param {string} a.viewerUrl          live three.ws viewer link
 * @param {string} [a.glbIpfs]          optional ipfs:// GLB (permanence copy)
 * @param {string} [a.imageIpfs]        optional ipfs:// thumbnail
 * @param {string} a.creatorWallet       base58 creator/owner wallet
 * @param {string} [a.creatorUserId]
 * @param {string} [a.prompt]            generation prompt (provenance)
 * @param {string} [a.generationModel]
 * @param {string} [a.generationProvider]
 * @param {string} [a.parentMint]        lineage parent asset (remix source)
 * @param {string[]} [a.lineage]         ancestor mints, root-last
 * @param {number} a.royaltyBps          effective (already-clamped) seller fee
 * @param {string} a.royaltyRecipient    wallet the royalty routes to
 * @param {'mainnet'|'devnet'} a.network
 * @param {string} a.createdAt           ISO timestamp
 * @returns {object} Metaplex metadata JSON
 */
export function buildTokenized3dMetadata(a) {
	const tok = threeTokenLinks();
	const description =
		a.description?.trim() ||
		`${a.name} — a 3D asset generated on ${THREE_WS.name}, minted on Solana as a live, ` +
			`interactive 3D NFT. Its media is a rigged glTF model, not a static image.`;

	const files = [
		{ uri: a.glbUrl, type: 'model/gltf-binary' },
		...(a.glbIpfs ? [{ uri: a.glbIpfs, type: 'model/gltf-binary' }] : []),
		{ uri: a.imageUrl, type: 'image/png' },
		...(a.imageIpfs ? [{ uri: a.imageIpfs, type: 'image/png' }] : []),
	];

	const attributes = [
		{ trait_type: 'Platform', value: THREE_WS.name },
		{ trait_type: 'Standard', value: 'Metaplex Core' },
		{ trait_type: 'Media', value: '3D / glTF-binary' },
		{ trait_type: 'Creator', value: a.creatorWallet },
		...(a.prompt ? [{ trait_type: 'Prompt', value: clamp(a.prompt, 256) }] : []),
		...(a.generationModel ? [{ trait_type: 'Model', value: clamp(a.generationModel, 96) }] : []),
		...(a.generationProvider ? [{ trait_type: 'Provider', value: clamp(a.generationProvider, 64) }] : []),
		...(a.parentMint ? [{ trait_type: 'Parent', value: a.parentMint }] : []),
		{ trait_type: 'Royalty', value: `${(a.royaltyBps / 100).toFixed(2)}%` },
		{ trait_type: '$THREE', value: tok.mint },
		{ trait_type: 'Network', value: a.network },
		{ trait_type: 'Created', value: a.createdAt },
	];

	const provenance = {
		platform: THREE_WS.name,
		creator: a.creatorWallet,
		...(a.creatorUserId ? { creator_user_id: a.creatorUserId } : {}),
		...(a.prompt ? { prompt: a.prompt } : {}),
		...(a.generationModel ? { generation_model: a.generationModel } : {}),
		...(a.generationProvider ? { generation_provider: a.generationProvider } : {}),
		...(a.parentMint ? { parent_mint: a.parentMint } : {}),
		...(a.lineage?.length ? { lineage: a.lineage } : {}),
		minted_at: a.createdAt,
		network: a.network,
	};

	return {
		// ── Metaplex token-metadata standard ──
		name: a.name,
		symbol: '3D',
		description,
		image: a.imageUrl,
		animation_url: a.glbUrl,
		external_url: a.viewerUrl,
		// Standard TM location for the royalty (legacy marketplace readers). The
		// enforced copy is the on-chain Core Royalties plugin; this mirrors it.
		seller_fee_basis_points: a.royaltyBps,
		attributes,
		properties: {
			category: '3d',
			files,
			creators: [{ address: a.royaltyRecipient, share: 100 }],
			seller_fee_basis_points: a.royaltyBps,
			provenance,
		},
		// ── three.ws brand block — links travel with the asset ──
		platform: {
			name: THREE_WS.name,
			url: THREE_WS.website,
			tagline: THREE_WS.tagline,
			x: THREE_WS.x,
			github: THREE_WS.github,
		},
		token: { symbol: tok.symbol, mint: tok.mint, url: tok.pumpfun },
		$schema: 'https://three.ws/schemas/tokenized-3d/0.1.json',
		spec: 'tokenized-3d/0.1',
	};
}

/**
 * The live three.ws viewer link for a GLB. Canonical format used across the
 * platform (api/_mcp-studio/forge-client.js viewerUrl).
 * @param {string} appOrigin
 * @param {string} glbUrl
 */
export function viewerLinkFor(appOrigin, glbUrl) {
	return `${appOrigin.replace(/\/$/, '')}/viewer?src=${encodeURIComponent(glbUrl)}`;
}

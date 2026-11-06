// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.
//
// Forge already has its own single listing source (api/_lib/forge-listing.js,
// shared with the live 402 challenge and guarded by
// tests/x402-forge-listing.test.js) — this descriptor imports it rather than
// copying it. `bazaar` is the fully-built {discoverable, info, schema} block;
// the discovery generator passes it through verbatim so the output schema
// survives (re-deriving from input/inputSchema would drop it). Price is
// tier-based: the catalog advertises the standard tier from forge-tiers.js —
// the single price source — while the live 402 quotes the exact tier requested.

import {
	FORGE_SERVICE_NAME,
	FORGE_TAGS,
	FORGE_ROUTE_DESCRIPTION,
	FORGE_INPUT_EXAMPLE,
	FORGE_INPUT_SCHEMA,
	FORGE_OUTPUT_SCHEMA,
	FORGE_BAZAAR,
} from '../../forge-listing.js';
import { priceAtomicsForTier } from '../../forge-tiers.js';

export default {
	slug: 'forge',
	title: 'Forge: text/image to 3D',
	category: '3d',
	useCase:
		'Forge — production text/image→3D for agents that need real assets, not drafts: game assets, NFT art, scene props, and product visualization as textured GLB.',
	path: '/api/x402/forge',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: String(priceAtomicsForTier('standard')),
	acceptsBuilder: 'standard',
	serviceName: FORGE_SERVICE_NAME,
	tags: [...FORGE_TAGS],
	description: FORGE_ROUTE_DESCRIPTION,
	input: FORGE_INPUT_EXAMPLE,
	inputSchema: FORGE_INPUT_SCHEMA,
	outputSchema: FORGE_OUTPUT_SCHEMA,
	bazaar: FORGE_BAZAAR,
	storefronts: ['x402scan'],
};

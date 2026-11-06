// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'avatar-optimize-batch',
	title: 'Avatar Optimizer',
	category: '3d',
	useCase: 'three.ws Avatar Optimization Pipeline — pay $0.001 USDC to trigger a batch glTF/GLB analysis of the top most-viewed public avatars.',
	path: '/api/x402/avatar-optimize-batch',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Avatar Optimizer',
	tags: ['3d', 'avatar', 'optimization', 'glb', 'batch'],
	description: 'three.ws Avatar Optimization Pipeline — pay $0.001 USDC to trigger a batch glTF/GLB analysis of the top most-viewed public avatars. Returns a ranked list of optimization suggestions (Draco/Meshopt compression, oversized textures, non-indexed primitives) and stores results per-avatar so owners can be notified of actionable improvements.',
	input: {
		limit: 50,
	},
	inputSchema: {
		type: 'object',
		properties: {
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 50,
				default: 50,
			},
		},
	},
	storefronts: ['x402scan'],
};

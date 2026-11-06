// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'asset-download',
	title: 'Asset Bazaar',
	category: '3d',
	useCase: 'three.ws Asset Bazaar — pay once in USDC to unlock a 3D asset (GLB, avatar, or accessory) hosted on R2.',
	path: '/api/x402/asset-download',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '100000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Asset Bazaar',
	tags: ['3d', 'asset', 'glb', 'avatar', 'download'],
	description: 'three.ws Asset Bazaar — pay once in USDC to unlock a 3D asset (GLB, avatar, or accessory) hosted on R2. Wallets that have already paid can re-download for free by signing in with SIWX (CAIP-122). Each asset has its own price and creator payout address; the response carries a short-lived presigned R2 URL the client uses to fetch the file directly.',
	input: {
		slug: 'pole-dancer-rumba',
	},
	inputSchema: {
		type: 'object',
		required: ['slug'],
		properties: {
			slug: {
				type: 'string',
				minLength: 1,
				maxLength: 128,
				description: 'Unique asset slug from the paid_assets catalog.',
			},
		},
	},
	storefronts: ['x402scan'],
};

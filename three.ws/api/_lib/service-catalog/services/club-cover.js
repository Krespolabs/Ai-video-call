// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'club-cover',
	title: 'Pole Club Cover',
	category: '3d',
	useCase: 'three.ws Pole Club Cover Charge — pay $0.01 USDC to access the three.ws Pole Club.',
	path: '/api/x402/club-cover',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '10000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Pole Club Cover',
	tags: ['3d', 'avatar', 'club', 'access', 'cover'],
	description: 'three.ws Pole Club Cover Charge — pay $0.01 USDC to access the three.ws Pole Club. Once the payment settles the caller receives an entry token granting access to the live club scene for 24 hours.',
	input: {},
	inputSchema: {
		type: 'object',
		properties: {},
	},
	storefronts: ['x402scan'],
};

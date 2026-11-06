// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'bazaar-feed',
	title: 'Bazaar Feed',
	category: 'agent-infra',
	useCase: 'Bazaar Feed — pay $0.001 USDC per call for two live views of the x402 service marketplace.',
	path: '/api/x402/bazaar-feed',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Bazaar Feed',
	tags: ['bazaar', 'listings', 'discovery', 'market', 'x402'],
	description: 'Bazaar Feed — pay $0.001 USDC per call for two live views of the x402 service marketplace. filter "new"/"active": newest service listings (id, name, price, networks, tags, first_seen) plus category rollup and listing-velocity signal (spike/active/quiet). filter "price_trends": 24h price-movement across all tracked services — trending up/down/stable and net market pressure as bullish/bearish/neutral. Live data from the platform bazaar index.',
	input: {
		filter: 'new',
		limit: 10,
	},
	inputSchema: {
		type: 'object',
		properties: {
			filter: {
				type: 'string',
				enum: ['new', 'active', 'price_trends'],
				default: 'new',
			},
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 50,
				default: 10,
			},
			period: {
				type: 'string',
				default: '24h',
			},
		},
	},
	storefronts: ['x402scan'],
};

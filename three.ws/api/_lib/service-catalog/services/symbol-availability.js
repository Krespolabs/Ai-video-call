// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'symbol-availability',
	title: 'Symbol Check',
	category: 'launch',
	useCase: 'Symbol Availability — pre-launch ticker collision check against three.ws\'s pump.fun mint index.',
	path: '/api/x402/symbol-availability',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Symbol Check',
	tags: ['ticker', 'pump.fun', 'collision', 'launch', 'solana'],
	description: 'Symbol Availability — pre-launch ticker collision check against three.ws\'s pump.fun mint index. Returns exact-symbol collisions plus trigram-similar tickers so launch agents can avoid name confusion and aggregator-search dilution.',
	input: {
		ticker: 'HELIO',
		network: 'mainnet',
	},
	inputSchema: {
		type: 'object',
		required: ['ticker'],
		properties: {
			ticker: {
				type: 'string',
				minLength: 1,
				maxLength: 32,
			},
			network: {
				type: 'string',
				enum: ['mainnet', 'devnet'],
			},
		},
	},
	storefronts: ['x402scan'],
};

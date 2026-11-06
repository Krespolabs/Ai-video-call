// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'pay-by-name',
	title: 'Pay-By-Name Resolution',
	category: 'payments',
	useCase: 'Pay-By-Name Resolution — pay $0.001 USDC to resolve a wallet name (@username, a *.sol name, or a raw base58 address) to a verified on-chain Solana address via the three.ws pay-by-name registry.',
	path: '/api/x402/pay-by-name',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'Pay-By-Name Resolution',
	tags: ['identity', 'resolution', 'solana'],
	description: 'Pay-By-Name Resolution — pay $0.001 USDC to resolve a wallet name (@username, a *.sol name, or a raw base58 address) to a verified on-chain Solana address via the three.ws pay-by-name registry. Returns the resolved address, an on-curve verification flag, and the resolution source.',
	input: {
		name: 'nich.threews.sol',
	},
	inputSchema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: {
				type: 'string',
				description: '@username, a *.sol name, or a base58 address.',
			},
		},
	},
	storefronts: ['x402scan'],
};

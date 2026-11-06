// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'cross-chain',
	title: 'Bridge Status',
	category: 'payments',
	useCase: 'Cross-Chain Bridge Status Monitor — pay $0.005 USDC to receive the live operational status and latency of major Solana bridge providers (Wormhole, Li.Fi, deBridge).',
	path: '/api/x402/cross-chain',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '5000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Bridge Status',
	tags: ['bridge', 'cross-chain', 'health', 'solana', 'wormhole'],
	description: 'Cross-Chain Bridge Status Monitor — pay $0.005 USDC to receive the live operational status and latency of major Solana bridge providers (Wormhole, Li.Fi, deBridge). Any bridge with status=down is flagged as a platform risk.',
	input: {
		mode: 'bridge_status',
	},
	inputSchema: {
		type: 'object',
		properties: {
			mode: {
				type: 'string',
				enum: ['bridge_status'],
				default: 'bridge_status',
			},
		},
	},
	storefronts: ['x402scan'],
};

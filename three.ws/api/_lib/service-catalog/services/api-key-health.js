// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'api-key-health',
	title: 'API Key Health Check',
	category: 'agent-infra',
	useCase: 'API Key Validity Health Check — verifies that the platform has a valid, non-expired access key covering a given scope.',
	path: '/api/x402/api-key-health',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws API Key Health Check',
	tags: ['health', 'api-key', 'autonomous', 'access-control'],
	description: 'API Key Validity Health Check — verifies that the platform has a valid, non-expired access key covering a given scope. Checks x402 subscription keys and the internal service key. Returns valid, scopes, expires_at, and key_type. Used by the autonomous loop to confirm its access lane is healthy before each tick. Pay-per-call in USDC on Solana or Base mainnet.',
	input: {
		scope: 'autonomous_loop',
	},
	inputSchema: {
		type: 'object',
		properties: {
			scope: {
				type: 'string',
				default: 'autonomous_loop',
			},
		},
	},
	storefronts: ['x402scan'],
};

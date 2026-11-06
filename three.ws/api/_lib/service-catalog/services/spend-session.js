// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'spend-session',
	title: 'Spend Session Health',
	category: 'payments',
	useCase: 'three.ws Spend Session Health — pay $0.01 USDC to probe the Agent Payment Sessions governance layer.',
	path: '/api/x402/spend-session',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '10000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Spend Session Health',
	tags: ['health', 'governance', 'payment-session', 'canary', 'x402'],
	description: 'three.ws Spend Session Health — pay $0.01 USDC to probe the Agent Payment Sessions governance layer. mode:"canary" creates a canary session row and immediately consumes it, returning { created, consumed, latency_ms } — the most important health check for the x402 governance layer. mode:"audit" returns a live aggregate snapshot of all payment sessions (active count, remaining budget, expired_count_24h). Pay-per-call in USDC on Solana mainnet.',
	input: {
		mode: 'canary',
		budget: 0.01,
	},
	inputSchema: {
		type: 'object',
		properties: {
			mode: {
				type: 'string',
				enum: ['canary', 'audit'],
				default: 'canary',
			},
			budget: {
				type: 'number',
				minimum: 0,
			},
		},
	},
	storefronts: ['x402scan'],
};

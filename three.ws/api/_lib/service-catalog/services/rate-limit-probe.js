// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'rate-limit-probe',
	title: 'Rate-Limit Probe',
	category: 'agent-infra',
	useCase: 'Rate-Limit Capacity Probe — pay $0.001 USDC to learn how many more calls the x402 autonomous loop can make to a target endpoint today before hitting its daily USDC spend cap.',
	path: '/api/x402/rate-limit-probe',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Rate-Limit Probe',
	tags: ['rate-limit', 'capacity', 'health', 'oracle', 'agent'],
	description: 'Rate-Limit Capacity Probe — pay $0.001 USDC to learn how many more calls the x402 autonomous loop can make to a target endpoint today before hitting its daily USDC spend cap. Returns remaining_calls, reset_at, and cooldown_active so agents can throttle dynamically instead of discovering the cap by failure.',
	input: {
		endpoint: '/api/x402/forge',
	},
	inputSchema: {
		type: 'object',
		required: ['endpoint'],
		properties: {
			endpoint: {
				type: 'string',
				pattern: '^/api/',
			},
		},
	},
	storefronts: ['x402scan'],
};

// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'auth-health',
	title: 'Auth Session Health',
	category: 'agent-infra',
	useCase: 'Auth Session Lifecycle Health — pay $0.001 USDC to exercise the full JWT auth session lifecycle: create, validate, refresh, and expiry-rejection.',
	path: '/api/x402/auth-health',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Auth Session Health',
	tags: ['auth', 'session', 'jwt', 'health', 'security'],
	description: 'Auth Session Lifecycle Health — pay $0.001 USDC to exercise the full JWT auth session lifecycle: create, validate, refresh, and expiry-rejection. Returns { all_pass, failed_step, latency_ms } so a monitoring loop can detect a broken auth subsystem before users do.',
	input: {
		mode: 'session_lifecycle',
	},
	inputSchema: {
		type: 'object',
		properties: {
			mode: {
				type: 'string',
				enum: ['session_lifecycle'],
				default: 'session_lifecycle',
			},
		},
	},
	storefronts: ['x402scan'],
};

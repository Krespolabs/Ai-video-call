// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'did',
	title: 'DID Health',
	category: 'agent-infra',
	useCase: 'DID Verification Canary — pay $0.001 USDC to resolve three.ws\'s published W3C DID document over its real public route, structurally validate it, and measure end-to-end resolution latency.',
	path: '/api/x402/did',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws DID Health',
	tags: ['did', 'identity', 'health', 'verification', 'x402'],
	description: 'DID Verification Canary — pay $0.001 USDC to resolve three.ws\'s published W3C DID document over its real public route, structurally validate it, and measure end-to-end resolution latency. Returns { verified, latency_ms } plus a per-check breakdown. verified=false when the document is unreachable, malformed, or slower than 1500ms — the same failure an external x402 verifier would hit resolving our offer/receipt signing key.',
	input: {
		did: 'did:three:canary',
		mode: 'verify',
	},
	inputSchema: {
		type: 'object',
		properties: {
			did: {
				type: 'string',
				default: 'did:three:canary',
			},
			mode: {
				type: 'string',
				enum: ['verify'],
				default: 'verify',
			},
		},
	},
	storefronts: ['x402scan'],
};

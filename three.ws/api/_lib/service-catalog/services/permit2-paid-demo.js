// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.
//
// acceptsBuilder 'permit2-only': the discovery entry advertises ONLY the
// gasless Permit2 accept (no EIP-3009 sibling), and is omitted entirely when
// CDP creds are absent — permit2VariantOf() returns null there, matching the
// runtime 402 behavior. tests/api/x402-discovery-parity.test.js documents the
// same exemption.

export default {
	slug: 'permit2-paid-demo',
	title: 'Permit2 Demo',
	category: 'payments',
	useCase:
		'Permit2 + EIP-2612 Gas Sponsoring Demo — forces the gasless Permit2 path so a fresh wallet holding USDC but ZERO ETH can complete the flow.',
	path: '/api/x402/permit2-paid-demo',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'permit2-only',
	serviceName: 'three.ws Permit2 Demo',
	tags: ['x402', 'permit2', 'eip2612', 'gasless', 'demo'],
	description:
		"Permit2 + EIP-2612 Gas Sponsoring Demo — forces the gasless Permit2 path so a fresh wallet holding USDC but ZERO ETH can complete the flow. CDP's x402ExactPermit2Proxy submits the EIP-2612 permit + Permit2 transfer atomically via settleWithPermit. Response surfaces the on-chain tx hash and a Basescan link.",
	input: {},
	inputSchema: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
	storefronts: ['x402scan'],
};

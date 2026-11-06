// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'solana-register-health',
	title: 'Solana Reg Health',
	category: 'agent-infra',
	useCase: 'Solana Agent Registration Health Check — verifies three.ws\'s server-custodial Solana agent-registration subsystem end-to-end by resolving a known canary agent\'s on-chain Metaplex Agent Registry record (Identity PDA + Core asset) and confirming both accounts exist on-chain right now.',
	path: '/api/x402/solana-register-health',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Solana Reg Health',
	tags: ['health', 'solana', 'registration', 'agent', 'canary'],
	description: 'Solana Agent Registration Health Check — verifies three.ws\'s server-custodial Solana agent-registration subsystem end-to-end by resolving a known canary agent\'s on-chain Metaplex Agent Registry record (Identity PDA + Core asset) and confirming both accounts exist on-chain right now. Returns a health snapshot with latency and the checked asset. Pay-per-call in USDC on Solana or Base mainnet.',
	input: {},
	inputSchema: {
		type: 'object',
		properties: {},
	},
	storefronts: ['x402scan'],
};

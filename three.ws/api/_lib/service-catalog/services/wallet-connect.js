// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'wallet-connect',
	title: 'Wallet Connect Health',
	category: 'agent-infra',
	useCase: 'Wallet Connection Session Health Check — probes the SIWS (Sign-In With Solana) session initiation path: issues a real nonce challenge against the platform auth gateway, validates its structure and expiry, and measures roundtrip latency.',
	path: '/api/x402/wallet-connect',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Wallet Connect Health',
	tags: ['health', 'wallet', 'siws', 'session', 'auth'],
	description: 'Wallet Connection Session Health Check — probes the SIWS (Sign-In With Solana) session initiation path: issues a real nonce challenge against the platform auth gateway, validates its structure and expiry, and measures roundtrip latency. Returns { session_created, latency_ms }. Pay-per-call in USDC on Solana or Base mainnet.',
	input: {
		mode: 'health',
	},
	inputSchema: {
		type: 'object',
		required: ['mode'],
		properties: {
			mode: {
				type: 'string',
				enum: ['health'],
			},
		},
	},
	storefronts: ['x402scan'],
};

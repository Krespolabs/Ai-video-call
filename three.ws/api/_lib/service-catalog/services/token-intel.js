// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'token-intel',
	title: 'Token Oracle',
	category: 'market-data',
	useCase: 'three.ws Token Oracle — pay $0.01 USDC per call for live market intel on ANY token by contract address: price, 24 h change, market cap, liquidity, 24 h volume, and a bullish / bearish / neutral signal with a two-sentence rationale.',
	path: '/api/x402/token-intel',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '10000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Token Oracle',
	tags: ['crypto', 'market', 'signal', 'oracle', 'solana'],
	description: 'three.ws Token Oracle — pay $0.01 USDC per call for live market intel on ANY token by contract address: price, 24 h change, market cap, liquidity, 24 h volume, and a bullish / bearish / neutral signal with a two-sentence rationale. Pass ?mint=<contract-address> (Solana mint or EVM 0x). The mint is supplied at runtime — generic coin-agnostic plumbing. Powered by live DexScreener data; this is the paid endpoint the CA-to-x402 resolver generates.',
	input: {
		mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	},
	inputSchema: {
		type: 'object',
		required: ['mint'],
		properties: {
			mint: {
				type: 'string',
				description: 'Token contract address — Solana base58 mint or EVM 0x address.',
			},
		},
	},
	storefronts: ['x402scan'],
};

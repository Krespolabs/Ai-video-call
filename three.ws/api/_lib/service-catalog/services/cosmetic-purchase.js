// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'cosmetic-purchase',
	title: 'Avatar Shop',
	category: '3d',
	useCase: 'three.ws Avatar Shop — pay once in USDC to unlock a premium avatar cosmetic (skin or emote) for an account.',
	path: '/api/x402/cosmetic-purchase',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '500000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Avatar Shop',
	tags: ['3d', 'avatar', 'cosmetic', 'shop', 'wearable'],
	description: 'three.ws Avatar Shop — pay once in USDC to unlock a premium avatar cosmetic (skin or emote) for an account. Pay on Base or Solana; the cosmetic is recorded to the buyer-specified account and is wearable across /play and /walk. Wallets that already purchased an item re-confirm for free by signing in with SIWX (CAIP-122). Price varies by rarity ($0.25–$3.00 USDC).',
	input: {
		id: 'skin-midnight',
		account: 'g_5f3c9a21b8',
	},
	inputSchema: {
		type: 'object',
		required: ['id', 'account'],
		properties: {
			id: {
				type: 'string',
				minLength: 1,
				maxLength: 64,
				description: 'Premium cosmetic id from /api/cosmetics/catalog.',
			},
			account: {
				type: 'string',
				minLength: 3,
				maxLength: 64,
				description: 'Account the cosmetic is granted to — a Solana wallet address or a guest id (g_…).',
			},
		},
	},
	storefronts: ['x402scan'],
};

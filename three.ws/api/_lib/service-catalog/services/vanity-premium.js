// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'vanity-premium',
	title: 'Premium Vanity',
	category: 'launch',
	useCase: 'Premium Vanity Inventory — buy a PRE-GROUND Solana address with a long (4–5+ char) brandable prefix, delivered instantly from stock.',
	path: '/api/x402/vanity-premium',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '1000000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Premium Vanity',
	tags: ['solana', 'vanity', 'wallet', 'address', 'premium'],
	description: 'Premium Vanity Inventory — buy a PRE-GROUND Solana address with a long (4–5+ char) brandable prefix, delivered instantly from stock. Browse available patterns and prices with a plain GET; buy one with GET ?address=<base58> via x402 (USDC on Base or Solana). Price scales with grind difficulty ($1–$50). The key is delivered exactly ONCE and its stored ciphertext is destroyed on delivery (delete-after-reveal). Optional sealTo=<X25519 public key> seals the key to you so plaintext never appears in the response. CUSTODY: keys are platform-generated — use one as a token MINT address or sweep assets to self-generated custody, not as a long-term treasury. Distinct from the live /api/x402/vanity grinder (fresh <=3-char keypair per request) — this tier sells rarer addresses too slow to grind on demand.',
	input: {
		address: '<base58 from the listing>',
	},
	inputSchema: {
		type: 'object',
		properties: {
			address: {
				type: 'string',
				description: 'A Base58 address from the premium inventory listing (GET with no address to browse). Buys that exact pre-ground address.',
			},
			sealTo: {
				type: 'string',
				description: 'Optional. Your 32-byte X25519 public key (Base58/Base64url/hex) to receive the key ECIES-sealed — plaintext never appears in the response.',
			},
		},
	},
	storefronts: ['x402scan'],
};

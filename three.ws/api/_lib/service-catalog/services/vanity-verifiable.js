// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'vanity-verifiable',
	title: 'Provable Vanity Grinder',
	category: 'launch',
	useCase: 'Provably-Fair Vanity Grinder — generate a brand-new Solana keypair whose Base58 address starts with a chosen prefix and/or ends with a chosen suffix, with a SIGNED receipt that proves the key was ground fresh and never kept.',
	path: '/api/x402/vanity-verifiable',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '20000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Provable Vanity Grinder',
	tags: ['solana', 'vanity', 'keypair', 'wallet', 'verifiable'],
	description: 'Provably-Fair Vanity Grinder — generate a brand-new Solana keypair whose Base58 address starts with a chosen prefix and/or ends with a chosen suffix, with a SIGNED receipt that proves the key was ground fresh and never kept. The server commits to a random 32-byte seed (commitment = SHA-256(serverSeed)) BEFORE grinding, mixes in your optional clientSeed, derives each candidate deterministically (HMAC-SHA256 → Ed25519), and signs the receipt with its long-lived service key (published at /.well-known/three-vanity.json). Pass sealTo=<X25519 public key> and the secret is ECIES-sealed to you — plaintext never appears in the response or any log. Verify entirely client-side with @three-ws/solana-agent verifyVanityReceipt(), the CLI, or three.ws/vanity/verify. Combined pattern capped at 3 Base58 chars, priced $0.02–$0.40; settlement runs only after a successful grind, so an exhausted budget costs nothing.',
	input: {
		prefix: 'So',
		suffix: '',
		ignoreCase: '0',
		sealTo: '',
	},
	inputSchema: {
		type: 'object',
		anyOf: [
			{
				required: ['prefix'],
			},
			{
				required: ['suffix'],
			},
		],
		properties: {
			prefix: {
				type: 'string',
				maxLength: 3,
				description: 'Base58 characters the address must start with (excludes 0, O, I, l). Combined with suffix, max 3.',
			},
			suffix: {
				type: 'string',
				maxLength: 3,
				description: 'Base58 characters the address must end with. Combined with prefix, max 3.',
			},
			ignoreCase: {
				type: 'string',
				enum: ['0', '1', 'true', 'false'],
				description: 'When 1/true, match case-insensitively (faster, less specific).',
			},
			sealTo: {
				type: 'string',
				description: 'Recommended. Your 32-byte X25519 public key (Base58/Base64url/hex). When set, the secret is ECIES-sealed to it and omitted from the response.',
			},
		},
	},
	storefronts: ['x402scan'],
};

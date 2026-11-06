// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'vanity',
	title: 'Vanity Grinder',
	category: 'launch',
	useCase: 'Vanity Grinder — put your brand on-chain: get a Solana address that starts with your ticker/prefix and/or ends with a chosen suffix, for a branded token MINT address, a recognizable agent/treasury wallet, or any wallet identifiable at a glance.',
	path: '/api/x402/vanity',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '10000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Vanity Grinder',
	tags: ['solana', 'vanity', 'keypair', 'wallet', 'address'],
	description: 'Vanity Grinder — put your brand on-chain: get a Solana address that starts with your ticker/prefix and/or ends with a chosen suffix, for a branded token MINT address, a recognizable agent/treasury wallet, or any wallet identifiable at a glance. The server grinds a brand-new keypair to match (no wallet, account, or SOL needed) and never stores it — the secret is served once over TLS and stripped from the replay cache. format=keypair (default) returns the address + secret key (Base58 + 64-byte array) importable into any Solana wallet, capped at 3 Base58 chars, priced $0.01 (1 char) / $0.05 (2) / $0.25 (3). format=mnemonic returns a BIP-39 seed phrase (12/24 words) whose derived key lands on the address, capped at 2 chars (~100× slower), priced $0.05 / $0.50. Optional sealTo=<X25519 pubkey> ECIES-seals the secret to you so plaintext never appears in the response or any log. Settlement runs only after a successful grind, so an exhausted budget costs nothing. Keyless — no API keys, no accounts.',
	input: {
		prefix: 'So',
		suffix: '',
		ignoreCase: '0',
		format: 'keypair',
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
				description: 'Base58 characters the address must start with (excludes 0, O, I, l). Combined with suffix, max 3 (keypair) or 2 (mnemonic).',
			},
			suffix: {
				type: 'string',
				maxLength: 3,
				description: 'Base58 characters the address must end with. Combined with prefix, max 3 (keypair) or 2 (mnemonic).',
			},
			ignoreCase: {
				type: 'string',
				enum: ['0', '1', 'true', 'false'],
				description: 'When 1/true, match case-insensitively (faster, less specific).',
			},
			format: {
				type: 'string',
				enum: ['keypair', 'mnemonic'],
				description: 'keypair (default): raw 64-byte Ed25519 secret key, up to 3 chars, $0.01–$0.25. mnemonic: BIP-39 seed phrase importable into any wallet, up to 2 chars, $0.05–$0.50.',
			},
			strength: {
				type: 'string',
				enum: ['128', '256'],
				description: 'Mnemonic mode only. 128 → 12 words (default), 256 → 24 words. Ignored for keypair.',
			},
			sealTo: {
				type: 'string',
				description: 'Optional. Your 32-byte X25519 public key (Base58/Base64url/hex). When set, the secret is ECIES-sealed to it and the plaintext is omitted from the response.',
			},
		},
	},
	storefronts: ['x402scan'],
};

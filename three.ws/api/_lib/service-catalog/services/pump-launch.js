// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'pump-launch',
	title: 'Pump Launcher',
	category: 'launch',
	useCase: 'Pump Launcher — launch a pump.fun token autonomously in one paid call: no SOL, no wallet, no account.',
	path: '/api/x402/pump-launch',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '5000000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Pump Launcher',
	tags: ['pump.fun', 'launch', 'deploy', 'token', 'solana'],
	description: 'Pump Launcher - launch a pump.fun token autonomously in one paid call: no SOL, no wallet, no account. You pay USDC; the server fronts the ~0.022 SOL deploy cost, optionally grinds a vanity mint, and signs the bonding-curve create tx. Supply name + symbol and either a pre-pinned metadataUri or an imageUrl (we pin the image + descriptor to pump.fun IPFS). Creator rewards accrue to any Solana wallet you nominate, or set holderReward to route protocol creator fees to token holders; optional vanity prefix/suffix brands the mint address. Funnel: check the ticker is free first with the FREE GET /api/crypto/symbol, then confirm the deploy on the FREE GET /api/crypto/launches feed. Returns mint + tx signature + metadataUri + pump.fun URL.',
	input: {
		name: 'Helios',
		symbol: 'HELIO',
		imageUrl: 'https://example.com/helios.png',
		creator: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
		holderReward: false,
	},
	inputSchema: {
		type: 'object',
		required: ['name', 'symbol'],
		oneOf: [
			{
				required: ['metadataUri'],
			},
			{
				required: ['imageUrl'],
			},
		],
		properties: {
			name: {
				type: 'string',
				minLength: 1,
				maxLength: 32,
			},
			symbol: {
				type: 'string',
				minLength: 1,
				maxLength: 10,
			},
			metadataUri: {
				type: 'string',
				maxLength: 2048,
			},
			imageUrl: {
				type: 'string',
				maxLength: 2048,
			},
			description: {
				type: 'string',
				maxLength: 2000,
			},
			twitter: {
				type: 'string',
				maxLength: 2048,
			},
			telegram: {
				type: 'string',
				maxLength: 2048,
			},
			website: {
				type: 'string',
				maxLength: 2048,
			},
			creator: {
				type: 'string',
				minLength: 32,
				maxLength: 44,
			},
			holderReward: {
				type: 'boolean',
			},
			vanityPrefix: {
				type: 'string',
				maxLength: 5,
			},
			vanitySuffix: {
				type: 'string',
				maxLength: 5,
			},
			vanityIgnoreCase: {
				type: 'boolean',
			},
		},
	},
	storefronts: ['x402scan'],
};

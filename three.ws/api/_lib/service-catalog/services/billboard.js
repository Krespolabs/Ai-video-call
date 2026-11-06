// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'billboard',
	title: 'Coin-World Billboard',
	category: 'agent-infra',
	useCase: 'three.ws coin worlds — feature your content on a 3D world’s billboard.',
	path: '/api/x402/billboard',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '50000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Coin-World Billboard',
	tags: ['3d', 'world', 'billboard', 'content', 'placement'],
	description: 'three.ws coin worlds — feature your content on a 3D world’s billboard. Pay once to hold the framed panel behind spawn: pass the coin-world mint plus an image URL and/or a short caption. The coin world renders your placement in place of its default content for everyone who walks in until the slot expires. It is a paid content canvas, not an ad unit — nothing is targeted or tracked.',
	input: {
		coin: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		image: 'https://three.ws/og-image.png',
		caption: 'gm from the gallery',
	},
	inputSchema: {
		type: 'object',
		required: ['coin'],
		properties: {
			coin: {
				type: 'string',
				pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
			},
			image: {
				type: 'string',
				format: 'uri',
			},
			caption: {
				type: 'string',
				maxLength: 80,
			},
		},
	},
	storefronts: ['x402scan'],
};

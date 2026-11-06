// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'skill-call',
	title: 'Skill Call',
	category: 'agent-infra',
	useCase: 'three.ws Skill Call — pay the per-call price of a marketplace skill in USDC (Base or Solana) and receive its executable payload: the tool schema and content the calling agent runs.',
	path: '/api/x402/skill-call',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '10000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Skill Call',
	tags: ['skill', 'agent', 'tool', 'pay-per-call'],
	description: 'three.ws Skill Call — pay the per-call price of a marketplace skill in USDC (Base or Solana) and receive its executable payload: the tool schema and content the calling agent runs. Payment settles straight to the skill author\'s wallet. Per-call pricing — every invocation is a fresh payment.',
	input: {
		skill: 'wallet-balance',
	},
	inputSchema: {
		type: 'object',
		required: ['skill'],
		properties: {
			skill: {
				type: 'string',
				minLength: 1,
				maxLength: 128,
				description: 'Unique skill slug from the marketplace_skills catalog.',
			},
		},
	},
	storefronts: ['x402scan'],
};

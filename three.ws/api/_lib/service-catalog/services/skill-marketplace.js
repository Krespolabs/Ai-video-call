// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'skill-marketplace',
	title: 'Skill Market',
	category: 'agent-infra',
	useCase: 'Skill Marketplace — list active skill listings with prices across all three.ws agents.',
	path: '/api/x402/skill-marketplace',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Skill Market',
	tags: ['marketplace', 'agent', 'skills', 'pricing', 'discovery'],
	description: 'Skill Marketplace — list active skill listings with prices across all three.ws agents. Filter by skill name to find the cheapest provider for a given capability. Returns price atomics, chain, currency, trial offer, and time-pass terms.',
	input: {
		skill: 'inspect_model',
		limit: 20,
	},
	inputSchema: {
		type: 'object',
		properties: {
			skill: {
				type: 'string',
			},
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 200,
			},
		},
	},
	storefronts: ['x402scan'],
};

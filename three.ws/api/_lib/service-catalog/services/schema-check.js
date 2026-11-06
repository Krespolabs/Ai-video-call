// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'schema-check',
	title: 'JSON API Schema Check',
	category: 'agent-infra',
	useCase: 'three.ws JSON API schema conformance checker — pay $0.001 USDC to fetch a named three.ws public API and validate its response against the declared schema.',
	path: '/api/x402/schema-check',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws JSON API Schema Check',
	tags: ['schema', 'validation', 'changelog', 'health', 'api'],
	description: 'three.ws JSON API schema conformance checker — pay $0.001 USDC to fetch a named three.ws public API and validate its response against the declared schema. Surfaces breaking schema changes before users notice a broken feed. Current target: changelog_json — the /changelog.json feed holders and RSS consumers depend on. Returns { valid, version, entry_count, schema_errors }.',
	input: {
		api: 'changelog_json',
	},
	inputSchema: {
		type: 'object',
		required: ['api'],
		additionalProperties: false,
		properties: {
			api: {
				type: 'string',
				enum: ['changelog_json'],
			},
		},
	},
	storefronts: ['x402scan'],
};

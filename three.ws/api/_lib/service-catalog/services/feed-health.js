// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'feed-health',
	title: 'Feed Health',
	category: 'agent-infra',
	useCase: 'three.ws Feed Health Validator — fetches a named public feed (changelog RSS, sitemap, etc.) and returns a structural health verdict: { valid, item_count, latest_title }.',
	path: '/api/x402/feed-health',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Feed Health',
	tags: ['rss', 'feed', 'health', 'changelog', 'validation'],
	description: 'three.ws Feed Health Validator — fetches a named public feed (changelog RSS, sitemap, etc.) and returns a structural health verdict: { valid, item_count, latest_title }. Pays $0.001 USDC per check. Supported feeds: changelog_rss. The latest_title is cross-checked against the canonical changelog record so both a broken XML feed and a stale/diverged feed surface as valid:false.',
	input: {
		feed: 'changelog_rss',
	},
	inputSchema: {
		type: 'object',
		required: ['feed'],
		properties: {
			feed: {
				type: 'string',
				enum: ['changelog_rss'],
			},
		},
	},
	storefronts: ['x402scan'],
};

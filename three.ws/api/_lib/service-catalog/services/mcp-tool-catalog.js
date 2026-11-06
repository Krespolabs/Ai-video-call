// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'mcp-tool-catalog',
	title: 'MCP Tool Discovery',
	category: 'agent-infra',
	useCase: 'three.ws MCP Tool Discovery — pay $0.001 USDC to discover MCP tools that were registered (or whose price/shape changed, or that were removed) on the three.ws MCP server since you last probed.',
	path: '/api/x402/mcp-tool-catalog',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws MCP Tool Discovery',
	tags: ['mcp', 'discovery', 'tools', 'catalog', 'agent'],
	description: 'three.ws MCP Tool Discovery — pay $0.001 USDC to discover MCP tools that were registered (or whose price/shape changed, or that were removed) on the three.ws MCP server since you last probed. Returns the diff against a durable tool registry so agents can feature-flag new capabilities the moment they ship instead of re-fetching and diffing tools/list themselves.',
	input: {
		mode: 'discover',
	},
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			mode: {
				type: 'string',
				enum: ['discover', 'sync', 'list'],
				default: 'discover',
			},
		},
	},
	storefronts: ['x402scan'],
};

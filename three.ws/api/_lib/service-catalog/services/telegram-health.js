// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'telegram-health',
	title: 'Telegram Bot Health',
	category: 'agent-infra',
	useCase: 'Changelog Telegram Bot Health Check — pays $0.001 USDC to verify that the three.ws platform bot can reach the Telegram API and is alive.',
	path: '/api/x402/telegram-health',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Telegram Bot Health',
	tags: ['health', 'telegram', 'bot', 'changelog', 'canary'],
	description: 'Changelog Telegram Bot Health Check — pays $0.001 USDC to verify that the three.ws platform bot can reach the Telegram API and is alive. Returns { reachable, bot_id, bot_username, latency_ms }. If unreachable, new changelog entries will not reach $THREE holders until the bot is restored.',
	input: {
		bot: 'changelog',
	},
	inputSchema: {
		type: 'object',
		required: ['bot'],
		additionalProperties: false,
		properties: {
			bot: {
				type: 'string',
				enum: ['changelog'],
			},
		},
	},
	storefronts: ['x402scan'],
};

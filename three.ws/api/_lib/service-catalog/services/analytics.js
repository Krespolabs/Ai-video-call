// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'analytics',
	title: 'Social Analytics',
	category: 'agent-infra',
	useCase: 'three.ws Economy Analytics — pay $0.005 USDC per call for a live, aggregated view of platform activity.',
	path: '/api/x402/analytics',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '5000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Social Analytics',
	tags: ['analytics', 'club', 'social', 'metrics', 'solana'],
	description: 'three.ws Economy Analytics — pay $0.005 USDC per call for a live, aggregated view of platform activity. "clubs": Pole Club economy — active stages, patrons, tip volume, cover charges, fastest-growing leaderboard. "agent_leaderboard": top agents by USDC spend over a trailing window. "marketplace": catalog stats — active listing count, price distribution normalised to USD + SOL at the live rate, new listings in the window, and the most-viewed / most-forked listing. All numbers are read live from the real ledgers and catalog tables.',
	input: {
		report: 'clubs',
		period: '24h',
	},
	inputSchema: {
		type: 'object',
		properties: {
			report: {
				type: 'string',
				enum: [
					'clubs',
					'agent_leaderboard',
					'marketplace',
					'revenue',
					'sniper_trades',
					'user_activity',
					'x402_volume',
				],
				default: 'clubs',
			},
			period: {
				type: 'string',
				enum: ['1h', '6h', '24h', '7d', '30d', 'all'],
				default: '24h',
			},
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 100,
				default: 10,
			},
			window_days: {
				type: 'integer',
				minimum: 1,
				maximum: 90,
				default: 7,
			},
			network: {
				type: 'string',
				enum: ['mainnet', 'devnet', 'all'],
				default: 'mainnet',
			},
		},
	},
	storefronts: ['x402scan'],
};

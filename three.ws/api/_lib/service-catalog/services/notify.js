// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'notify',
	title: 'Notification Delivery',
	category: 'agent-infra',
	useCase: 'Notification Delivery Probe — pay $0.001 USDC to send a canary message through the platform notification channel and confirm delivery.',
	path: '/api/x402/notify',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Notification Delivery',
	tags: ['notification', 'canary', 'health', 'delivery', 'ops'],
	description: 'Notification Delivery Probe — pay $0.001 USDC to send a canary message through the platform notification channel and confirm delivery. Returns { delivered, channel, latency_ms } so the autonomous loop can assert the notification subsystem is alive within a 2-second SLA. Channel "canary" is the x402 loop heartbeat lane; "ops" and "system" route to the ops alert surface.',
	input: {
		channel: 'canary',
		message: 'x402 loop heartbeat',
		priority: 'low',
	},
	inputSchema: {
		type: 'object',
		properties: {
			channel: {
				type: 'string',
				enum: ['canary', 'ops', 'system'],
				default: 'canary',
			},
			message: {
				type: 'string',
				maxLength: 500,
				default: 'x402 loop heartbeat',
			},
			priority: {
				type: 'string',
				enum: ['low', 'normal', 'high'],
				default: 'low',
			},
		},
	},
	storefronts: ['x402scan'],
};

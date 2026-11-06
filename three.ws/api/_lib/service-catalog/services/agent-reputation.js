// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'agent-reputation',
	title: 'Cross-chain Agent Reputation',
	category: 'trust',
	useCase: 'Cross-chain Agent Reputation — get a deterministic 0–100 trust score for ANY counterparty (Solana wallet, EVM wallet, pump.fun mint, ERC-8004 agent id, or three.ws agent_id — auto-detected) before you pay, trade, or delegate to it.',
	path: '/api/x402/agent-reputation',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '10000',
	acceptsBuilder: 'standard',
	serviceName: 'Cross-chain Agent Reputation',
	tags: ['reputation', 'trust', 'cross-chain', 'agent', 'x402'],
	description: 'Cross-chain Agent Reputation — get a deterministic 0–100 trust score for ANY counterparty (Solana wallet, EVM wallet, pump.fun mint, ERC-8004 agent id, or three.ws agent_id — auto-detected) before you pay, trade, or delegate to it. Scored from real on-chain evidence: transaction history, age, distinct counterparties, holdings, settlement reliability, prior settled agent payments, and ERC-8004 feedback. Unknown subjects return score:null, not a fabricated score.',
	input: {
		subject: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	},
	inputSchema: {
		type: 'object',
		required: ['subject'],
		properties: {
			subject: {
				type: 'string',
			},
			chain: {
				type: ['integer', 'string'],
			},
		},
	},
	storefronts: ['x402scan'],
};

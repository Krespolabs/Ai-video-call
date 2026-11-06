// Catalog entry for GET /api/crypto/wallet — the free wallet-portfolio endpoint.
//
// The /api/crypto index (prompt 10) globs every file in this directory and merges
// the entries into the bundle's discovery doc + OpenAPI. Each entry is a plain,
// serializable descriptor: no imports, no side effects, safe to load anywhere.

export default {
	slug: 'wallet',
	method: 'GET',
	path: '/api/crypto/wallet',
	title: 'Wallet Portfolio',
	summary:
		'Native balance, every SPL/token holding, and a rough USD valuation for any wallet — keyless. For treasury, copy-trade, and pre-trade counterparty checks.',
	inputSchema: {
		type: 'object',
		required: ['address'],
		properties: {
			address: {
				type: 'string',
				description: 'Wallet address to inspect (Solana base58 or EVM 0x).',
			},
			chain: {
				type: 'string',
				enum: ['solana', 'ethereum'],
				default: 'solana',
				description: 'Chain to read. Solana is keyless; Ethereum needs a provider key.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			address: { type: 'string' },
			chain: { type: 'string' },
			native: {
				type: 'object',
				properties: {
					symbol: { type: 'string' },
					amount: { type: 'number' },
					usd: { type: ['number', 'null'] },
				},
			},
			tokens: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						mint: { type: 'string' },
						symbol: { type: ['string', 'null'] },
						name: { type: ['string', 'null'] },
						amount: { type: 'number' },
						usd: { type: ['number', 'null'] },
						logo: { type: ['string', 'null'] },
					},
				},
			},
			totalUsd: { type: 'number' },
			tokenCount: { type: 'integer' },
			truncated: { type: 'boolean' },
			ts: { type: 'string', format: 'date-time' },
			sources: { type: 'array', items: { type: 'string' } },
		},
	},
	example: '/api/crypto/wallet?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&chain=solana',
};

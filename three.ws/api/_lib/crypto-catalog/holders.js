// Catalog entry for GET /api/crypto/holders — the free holder-distribution
// endpoint.
//
// The /api/crypto index merges this descriptor into the bundle's discovery doc
// + OpenAPI (via the STATIC_ENTRIES barrel in index.js). Plain, serializable,
// no imports, no side effects.

export default {
	slug: 'holders',
	method: 'GET',
	path: '/api/crypto/holders',
	title: 'Holders & Concentration',
	summary:
		'Holder distribution for any Solana token: top wallets with amounts and % of supply, cumulative top-10 share, and a documented low/medium/high concentration verdict — the exit-risk read an agent needs before sizing a position. Keyless top-N via RPC; exact holder count when the deployment has an indexer key.',
	inputSchema: {
		type: 'object',
		required: ['address'],
		properties: {
			address: {
				type: 'string',
				description: 'Solana token mint to inspect (base58).',
			},
			chain: {
				type: 'string',
				enum: ['solana'],
				default: 'solana',
				description: 'Solana only — SPL token accounts have no EVM equivalent in this reader.',
			},
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 50,
				default: 10,
				description: 'How many top holders to return (capped at 50).',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			address: { type: 'string' },
			chain: { type: 'string' },
			holderCount: { type: ['integer', 'null'] },
			top: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						owner: { type: 'string' },
						amount: { type: 'number' },
						pct: { type: ['number', 'null'] },
					},
				},
			},
			top10Pct: { type: ['number', 'null'] },
			concentration: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'] },
			ts: { type: 'string', format: 'date-time' },
			sources: { type: 'array', items: { type: 'string' } },
			note: { type: 'string' },
		},
	},
	example: '/api/crypto/holders?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&limit=10',
};

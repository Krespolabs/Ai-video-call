// Catalog entry for GET /api/crypto/security — the free token-safety endpoint.
//
// The /api/crypto index globs every file in this directory and merges the
// entries into the bundle's discovery doc + OpenAPI. Each entry is a plain,
// serializable descriptor: no imports, no side effects, safe to load anywhere.

export default {
	slug: 'security',
	method: 'GET',
	path: '/api/crypto/security',
	title: 'Token Security / Rug Signals',
	summary:
		'Pre-trade safety check for any Solana token: mint & freeze authority status, holder concentration, liquidity depth, metadata mutability, LP custody — composed into a documented, deterministic riskLevel (low/medium/high/unknown) with plain-language reasons. Facts, never an LLM opinion; unknowns stay null.',
	inputSchema: {
		type: 'object',
		required: ['address'],
		properties: {
			address: {
				type: 'string',
				description: 'Solana token mint to check (base58).',
			},
			chain: {
				type: 'string',
				enum: ['solana'],
				default: 'solana',
				description: 'Solana only — SPL authorities and holder concentration have no EVM equivalent in this reader.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			address: { type: 'string' },
			chain: { type: 'string' },
			checks: {
				type: 'object',
				properties: {
					mintAuthorityRevoked: { type: ['boolean', 'null'] },
					freezeAuthorityRevoked: { type: ['boolean', 'null'] },
					metadataMutable: { type: ['boolean', 'null'] },
					lpBurnedOrLocked: { type: ['boolean', 'null'] },
					liquidityUsd: { type: ['number', 'null'] },
					topHolderPctFlag: { type: ['boolean', 'null'] },
				},
			},
			riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'] },
			reasons: { type: 'array', items: { type: 'string' } },
			ts: { type: 'string', format: 'date-time' },
			sources: { type: 'array', items: { type: 'string' } },
		},
	},
	example: '/api/crypto/security?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
};

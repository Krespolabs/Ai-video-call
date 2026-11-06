// Catalog entry for GET /api/crypto/token — the free token-snapshot endpoint.
//
// The /api/crypto index globs every file in this directory and merges the
// entries into the bundle's discovery doc + OpenAPI. Each entry is a plain,
// serializable descriptor: no imports, no side effects, safe to load anywhere.

export default {
	slug: 'token',
	method: 'GET',
	path: '/api/crypto/token',
	title: 'Token Snapshot',
	summary:
		'Current market state of any token by contract address in one call — price, 24 h change, market cap, FDV, liquidity, volume, venue link. DexScreener-backed with a keyless pump.fun fallback for fresh Solana launches. For buy / alert / ignore decisions.',
	inputSchema: {
		type: 'object',
		required: ['address'],
		properties: {
			address: {
				type: 'string',
				description: 'Token contract address (Solana base58 mint or EVM 0x contract).',
			},
			chain: {
				type: 'string',
				description:
					"Optional chain filter ('solana', 'ethereum', 'base', 'bsc', …). Inferred from the address shape when omitted; pins multi-chain EVM deployments to one chain.",
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			address: { type: 'string' },
			chain: { type: 'string' },
			name: { type: ['string', 'null'] },
			symbol: { type: ['string', 'null'] },
			priceUsd: { type: ['number', 'null'] },
			change24h: { type: ['number', 'null'] },
			marketCapUsd: { type: ['number', 'null'] },
			liquidityUsd: { type: ['number', 'null'] },
			volume24hUsd: { type: ['number', 'null'] },
			fdvUsd: { type: ['number', 'null'] },
			pairCreatedAt: { type: ['string', 'null'], format: 'date-time' },
			dexId: { type: ['string', 'null'] },
			url: { type: ['string', 'null'] },
			ts: { type: 'string', format: 'date-time' },
			sources: { type: 'array', items: { type: 'string' } },
			note: { type: 'string' },
		},
	},
	example: '/api/crypto/token?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
};

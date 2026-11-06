// Crypto Data API catalog entry — trending / hot tokens.
// Globbed by api/_lib/crypto-catalog/index.js (prompt 10) into the /api/crypto
// index + OpenAPI doc. Stands alone if that assembler doesn't exist yet.

export default {
	slug: 'trending',
	method: 'GET',
	path: '/api/crypto/trending',
	title: 'Trending / hot tokens',
	summary:
		"Solana tokens ranked by momentum (windowed volume + buy pressure + volume spike + " +
		"short-window price change) fused across pump.fun, DexScreener, and GMGN smart money. " +
		"One call for a discovery agent's \"what's hot right now\".",
	inputSchema: {
		type: 'object',
		properties: {
			window: {
				type: 'string',
				enum: ['5m', '1h', '24h'],
				default: '1h',
				description: 'Trade window the momentum score measures.',
			},
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 50,
				default: 20,
				description: 'Max tokens to return (capped at 50).',
			},
			source: {
				type: 'string',
				enum: ['pumpfun', 'all'],
				default: 'all',
				description: "'pumpfun' restricts to the pump.fun board; 'all' fuses every source.",
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			window: { type: 'string' },
			tokens: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						mint: { type: 'string' },
						symbol: { type: ['string', 'null'] },
						name: { type: ['string', 'null'] },
						marketCapUsd: { type: ['number', 'null'] },
						volumeUsd: { type: ['number', 'null'] },
						change: { type: ['number', 'null'], description: 'Price change % over the window.' },
						score: { type: 'number', description: 'Momentum score 0–100, ranked desc.' },
						url: { type: ['string', 'null'] },
					},
					required: ['mint', 'score'],
				},
			},
			count: { type: 'integer' },
			ts: { type: 'string', format: 'date-time' },
			sources: { type: 'array', items: { type: 'string' } },
			note: { type: 'string' },
		},
		required: ['window', 'tokens', 'count', 'ts', 'sources'],
	},
	example: {
		request: '/api/crypto/trending?window=1h&limit=5&source=all',
		response: {
			window: '1h',
			tokens: [
				{
					mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
					symbol: 'THREE',
					name: 'three.ws',
					marketCapUsd: 412000,
					volumeUsd: 18450.32,
					change: 12.4,
					score: 87.5,
					url: 'https://pump.fun/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
				},
			],
			count: 1,
			ts: '2026-07-07T00:00:00.000Z',
			sources: ['pumpfun', 'dexscreener'],
		},
	},
};

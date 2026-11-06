// Crypto Data API catalog entry — whale / large-buy activity.
// Globbed by api/_lib/crypto-catalog/index.js (prompt 10) into the /api/crypto
// front-door index + OpenAPI doc. Stands alone if that index doesn't exist yet.

export default {
	slug: 'whales',
	method: 'GET',
	path: '/api/crypto/whales',
	title: 'Whale / Large-Buy Activity',
	summary:
		'Free read of large buys on pump.fun. Pass ?mint= for whale buys of a specific ' +
		'token, or omit it for the top whale wallets active across the market. Returns a ' +
		'deterministic bullish/bearish/neutral buy-pressure signal so an agent can tell ' +
		'whether big money is moving in before it commits.',
	free: true,
	keyless: true,
	inputSchema: {
		type: 'object',
		properties: {
			mint: {
				type: 'string',
				description:
					'Optional base58 Solana mint. Present → whale buys of that token; ' +
					'omitted → top whale wallets active across pump.fun.',
			},
			minSol: {
				type: 'number',
				minimum: 0.1,
				default: 5,
				description: 'Minimum SOL in a single buy to qualify as a whale.',
			},
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 25,
				default: 10,
				description: 'Rows to return.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		required: ['scope', 'whales', 'whaleCount', 'totalSolMoved', 'signal', 'ts', 'source'],
		properties: {
			scope: { type: 'string', enum: ['token', 'market'] },
			mint: { type: ['string', 'null'] },
			minSol: { type: 'number' },
			whales: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						wallet: { type: 'string' },
						solMoved: { type: 'number' },
						txHash: { type: ['string', 'null'] },
						ts: { type: ['string', 'null'], format: 'date-time' },
					},
				},
			},
			whaleCount: { type: 'integer', minimum: 0 },
			totalSolMoved: { type: 'number', minimum: 0 },
			signal: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
			ts: { type: 'string', format: 'date-time' },
			source: { type: 'string' },
			note: { type: 'string' },
		},
	},
	example: {
		scope: 'token',
		mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		minSol: 5,
		whales: [
			{
				wallet: 'AbcDEF12345GHJKLMNopqrstuvwxyZabcdefghijk1',
				solMoved: 12.4,
				txHash: '5xTr4nSacT1oNsigNaTuReExampLe1111111111111111111111111111111111',
				ts: '2026-07-07T00:00:00.000Z',
			},
		],
		whaleCount: 1,
		totalSolMoved: 12.4,
		signal: 'bullish',
		ts: '2026-07-07T00:00:00.000Z',
		source: 'pump.fun',
	},
};

// Crypto Data API catalog entry — bonding-curve / graduation status.
// Globbed by api/_lib/crypto-catalog/index.js (prompt 10) into the /api/crypto
// front-door index + OpenAPI doc. Stands alone if that index doesn't exist yet.

export default {
	slug: 'bonding',
	method: 'GET',
	path: '/api/crypto/bonding',
	title: 'Bonding-Curve / Graduation Status',
	summary:
		'Where a pump.fun token sits on its bonding curve — % to graduation, SOL in the ' +
		'curve, and tokens left to buy — plus whether it has already graduated and ' +
		'migrated to an AMM (Raydium / PumpSwap). The read an agent needs to time entries ' +
		'and exits around graduation.',
	free: true,
	keyless: true,
	inputSchema: {
		type: 'object',
		required: ['mint'],
		properties: {
			mint: {
				type: 'string',
				description: 'pump.fun token mint (base58 Solana address).',
			},
		},
	},
	outputSchema: {
		type: 'object',
		required: ['mint', 'onCurve', 'graduated', 'ts', 'source'],
		properties: {
			mint: { type: 'string' },
			onCurve: { type: 'boolean', description: 'true while still on the bonding curve' },
			bondingProgressPct: {
				type: ['number', 'null'],
				minimum: 0,
				maximum: 100,
				description: 'share of the curve bought out (100 once graduated)',
			},
			solInCurve: {
				type: ['number', 'null'],
				description: 'real SOL reserves in the curve (null once graduated)',
			},
			tokensRemaining: {
				type: ['number', 'null'],
				description: 'tokens left to buy on the curve (null once graduated)',
			},
			marketCapUsd: { type: ['number', 'null'] },
			graduated: {
				type: 'boolean',
				description: 'completed the curve and migrated to an AMM',
			},
			migratedTo: {
				type: ['string', 'null'],
				enum: ['raydium', 'pumpswap', null],
				description: 'the AMM a graduated token migrated to',
			},
			ts: { type: 'string', format: 'date-time' },
			source: { type: 'string' },
		},
	},
	example: {
		mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		onCurve: true,
		bondingProgressPct: 70.67,
		solInCurve: 32.81,
		tokensRemaining: 232581073.73,
		marketCapUsd: 10095.72,
		graduated: false,
		migratedTo: null,
		ts: '2026-07-07T00:00:00.000Z',
		source: 'pumpfun',
	},
	related: ['/api/crypto/launches', '/api/crypto/whales'],
	tags: ['pump.fun', 'bonding-curve', 'graduation'],
};

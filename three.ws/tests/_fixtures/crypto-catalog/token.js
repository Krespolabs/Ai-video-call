// Fixture: a well-formed catalog entry exported as `default`.
export default {
	slug: 'token',
	method: 'get',
	path: '/api/crypto/token',
	title: 'Token Snapshot',
	summary: 'Current market state for a token in one call.',
	inputSchema: {
		type: 'object',
		properties: {
			address: { type: 'string', description: 'Mint / pair / contract address' },
			chain: { type: 'string', description: 'solana | base | …' },
		},
		required: ['address'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			address: { type: 'string' },
			priceUsd: { type: ['number', 'null'] },
		},
	},
	example: { address: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', priceUsd: 0.0001 },
};

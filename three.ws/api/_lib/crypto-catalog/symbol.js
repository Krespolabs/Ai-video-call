// Catalog entry for GET/POST /api/crypto/symbol — the free symbol-availability
// check. The /api/crypto index (prompt 10) globs every file in this directory
// and reflects it in the bundle listing + OpenAPI doc. This file stands alone:
// if the index doesn't exist yet, the endpoint still works.

export default {
	slug: 'symbol',
	method: 'GET',
	methods: ['GET', 'POST'],
	path: '/api/crypto/symbol',
	title: 'Symbol availability',
	summary:
		'Check up to 20 candidate ticker symbols for exact and fuzzy (look-alike) ' +
		'collisions across live token registries before launching a token. Free, ' +
		'keyless. Feeds the paid Pump Launcher — clear the name here, mint there.',
	inputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['symbols'],
		properties: {
			symbols: {
				type: 'array',
				items: { type: 'string', minLength: 1, maxLength: 32 },
				minItems: 1,
				maxItems: 20,
				description: 'Candidate tickers. GET accepts a comma-separated ?symbols=A,B,C.',
			},
			chain: {
				type: 'string',
				description: 'Optional chain filter (e.g. "solana"). Omit to check every indexed chain.',
			},
		},
	},
	outputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['results', 'availableCount', 'takenCount', 'ts'],
		properties: {
			results: {
				type: 'array',
				items: {
					type: 'object',
					required: ['symbol', 'available', 'exactCollisions', 'fuzzyCollisions'],
					properties: {
						symbol: { type: 'string' },
						available: { type: ['boolean', 'null'], description: 'null when the source could not be reached' },
						exactCollisions: { type: 'array', items: { type: 'object' } },
						fuzzyCollisions: { type: 'array', items: { type: 'object' } },
						note: { type: 'string' },
					},
				},
			},
			availableCount: { type: 'number' },
			takenCount: { type: 'number' },
			degraded: { type: 'boolean' },
			chain: { type: ['string', 'null'] },
			ts: { type: 'string', format: 'date-time' },
		},
	},
	example: {
		request: 'GET /api/crypto/symbol?symbols=THREE,MOONZ,BLERGZ&chain=solana',
		response: {
			results: [
				{
					symbol: 'THREE',
					available: false,
					exactCollisions: [
						{
							symbol: 'three',
							name: 'three.ws',
							mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
							chain: 'solana',
						},
					],
					fuzzyCollisions: [],
				},
				{ symbol: 'MOONZ', available: true, exactCollisions: [], fuzzyCollisions: [] },
				{ symbol: 'BLERGZ', available: true, exactCollisions: [], fuzzyCollisions: [] },
			],
			availableCount: 2,
			takenCount: 1,
			chain: 'solana',
			ts: '2026-07-07T00:00:00.000Z',
		},
	},
};

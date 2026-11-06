// Crypto Data API catalog entry — live pump.fun launches feed.
// Globbed by api/_lib/crypto-catalog/index.js into the /api/crypto front-door
// index + OpenAPI doc. Stands alone if that index doesn't exist yet.

export default {
	slug: 'launches',
	method: 'GET',
	path: '/api/crypto/launches',
	title: 'Live pump.fun Launches',
	summary:
		'The freshest pump.fun launches, newest first, with the fields a sniper/discovery ' +
		'agent filters on: name, symbol, mint, age, market cap, bonding-curve progress, and ' +
		'dev wallet. Poll it free, then watch the interesting mints via /api/crypto/bonding ' +
		'and /api/crypto/whales.',
	free: true,
	keyless: true,
	inputSchema: {
		type: 'object',
		properties: {
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 100,
				default: 20,
				description: 'How many launches to return (newest first).',
			},
			minMarketCap: {
				type: 'number',
				minimum: 0,
				description: 'Only launches at or above this USD market cap.',
			},
			maxAgeMin: {
				type: 'number',
				exclusiveMinimum: 0,
				description: 'Only launches at most this many minutes old.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		required: ['launches', 'count', 'ts', 'source'],
		properties: {
			launches: {
				type: 'array',
				items: {
					type: 'object',
					required: ['mint', 'url'],
					properties: {
						mint: { type: 'string' },
						name: { type: ['string', 'null'] },
						symbol: { type: ['string', 'null'] },
						createdAt: { type: ['string', 'null'], format: 'date-time' },
						ageMinutes: { type: ['number', 'null'] },
						marketCapUsd: { type: ['number', 'null'] },
						bondingProgressPct: { type: ['number', 'null'], minimum: 0, maximum: 100 },
						graduated: { type: 'boolean' },
						dev: { type: ['string', 'null'], description: 'creator wallet' },
						url: { type: 'string', description: 'pump.fun coin page' },
						imageUrl: { type: ['string', 'null'] },
					},
				},
			},
			count: { type: 'integer' },
			ts: { type: 'string', format: 'date-time' },
			source: {
				type: 'string',
				description: '"pumpfun", or "pumpfun:unavailable" when the feed is momentarily unreachable (still a 200 with an empty sweep).',
			},
			note: { type: 'string', description: 'present when the sweep is empty — says why' },
		},
	},
	example: {
		launches: [
			{
				mint: 'THREEsynthetic111111111111111111111111111111',
				name: 'Example Launch',
				symbol: 'EXMPL',
				createdAt: '2026-07-07T00:00:00.000Z',
				ageMinutes: 3.5,
				marketCapUsd: 6543.21,
				bondingProgressPct: 4.2,
				graduated: false,
				dev: 'THREEsyntheticDev11111111111111111111111111',
				url: 'https://pump.fun/coin/THREEsynthetic111111111111111111111111111111',
				imageUrl: null,
			},
		],
		count: 1,
		ts: '2026-07-07T00:00:00.000Z',
		source: 'pumpfun',
	},
	related: ['/api/crypto/bonding', '/api/crypto/whales', '/api/crypto/trending'],
	tags: ['pump.fun', 'launches', 'discovery', 'sniper'],
};

// GET /api/x402/token-intel?mint=<contract-address>
//
// Generic token oracle — $0.01 USDC per call on Solana or Base. Pass ANY token
// contract address (Solana mint or EVM 0x) and get live market intel for it:
// price, 24 h change, market cap, liquidity, 24 h volume, plus a
// bullish/bearish/neutral signal with a two-sentence rationale.
//
// This is the paid service the CA → x402 resolver (/ca2x402) generates: paste a
// contract address there and it hands you a ready-to-call x402 endpoint pointed
// at that exact token. The mint is supplied at runtime by the caller — generic,
// coin-agnostic plumbing, never an endorsement of any specific non-$THREE coin.
//
// Data is live: DexScreener public API (no key required). No mock path. If live
// data is unavailable, the handler throws BEFORE settlement so the buyer is
// never charged for a missing or fabricated signal.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { fetchTokenMarket, buildTokenSignal, buildTokenRisk, isResolvableAddress } from '../_lib/token-market.js';
import tokenIntelListing from '../_lib/service-catalog/services/token-intel.js';

const ROUTE = '/api/x402/token-intel';

// Single source of truth: api/_lib/service-catalog/services/token-intel.js is
// the storefront listing copy — importing it here keeps the live 402 challenge
// from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = tokenIntelListing.description;

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mint'],
	properties: {
		mint: {
			type: 'string',
			description: 'Token contract address — Solana base58 mint or EVM 0x address.',
			minLength: 32,
			maxLength: 64,
		},
	},
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mint', 'signal', 'headline', 'rationale', 'confidence', 'risk', 'ts'],
	properties: {
		mint:            { type: 'string' },
		symbol:          { type: ['string', 'null'] },
		name:            { type: ['string', 'null'] },
		chain:           { type: ['string', 'null'] },
		price_usd:       { type: ['number', 'null'] },
		change_24h:      { type: ['number', 'null'] },
		market_cap_usd:  { type: ['number', 'null'] },
		liquidity_usd:   { type: ['number', 'null'] },
		volume_24h_usd:  { type: ['number', 'null'] },
		momentum: {
			type: 'object',
			description: 'Price change (%) per window — m5, h1, h6, h24.',
			properties: {
				m5:  { type: ['number', 'null'] },
				h1:  { type: ['number', 'null'] },
				h6:  { type: ['number', 'null'] },
				h24: { type: ['number', 'null'] },
			},
		},
		signal:          { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
		headline:        { type: 'string' },
		rationale:       { type: 'string' },
		confidence:      { type: 'number', minimum: 0, maximum: 1 },
		risk: {
			type: 'object',
			description: 'Due-diligence risk score (0 safe … 100 critical) with the factors behind it.',
			required: ['score', 'level', 'summary', 'factors'],
			properties: {
				score:   { type: 'integer', minimum: 0, maximum: 100 },
				level:   { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
				summary: { type: 'string' },
				factors: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							label:  { type: 'string' },
							status: { type: 'string', enum: ['low', 'medium', 'high', 'critical', 'unknown'] },
							detail: { type: 'string' },
						},
					},
				},
			},
		},
		ts:              { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['token market signal', 'memecoin due-diligence', 'agent trading intel'],
	input: {
		type: 'query',
		example: { mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' },
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: {
			mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
			symbol: 'THREE', name: 'three.ws', chain: 'solana',
			price_usd: 0.003685, change_24h: 12.4, market_cap_usd: 3685000,
			liquidity_usd: 412000, volume_24h_usd: 1268079,
				momentum: { m5: 0.3, h1: 1.8, h6: 6.1, h24: 12.4 },
			signal: 'bullish',
			headline: 'THREE climbs +12.40% — moderate upside',
			rationale: 'THREE is up +12.40% over 24 h, trading at $0.003685. Volume is healthy against liquidity; participation is real. Buyers dominate the tape. The last hour confirms the trend.',
			confidence: 0.86,
				risk: {
					score: 8, level: 'low',
					summary: 'THREE clears the basic depth, age, and flow checks.',
					factors: [
						{ label: 'Liquidity', status: 'low', detail: '$412,000 pooled — healthy depth.' },
						{ label: 'Age', status: 'low', detail: 'Pair is 240d old — established.' },
						{ label: 'Float', status: 'low', detail: 'Cap is 8.9× liquidity — well backed.' },
						{ label: 'Flow', status: 'low', detail: '63% of 24 h trades are buys — net accumulation.' },
					],
				},
				ts: '2026-06-12T10:00:00Z',
		},
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('token-intel', '10000'), // $0.01 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Token Oracle',
		tags: ['token', 'market', 'signal', 'ca2x402', 'solana', 'base'],
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const mint = new URL(req.url, 'http://x').searchParams.get('mint')?.trim();
		if (!mint || !isResolvableAddress(mint)) {
			// Validation failure is thrown (not settled) so the buyer is not charged
			// for a malformed request — the wrapper maps this to a 422 before settle.
			throw Object.assign(new Error('mint must be a valid Solana or EVM contract address'), {
				status: 422,
				code: 'invalid_mint',
			});
		}

		let live = null;
		try { live = await fetchTokenMarket(mint); } catch { /* upstream hiccup */ }

		if (!live || live.change_24h == null) {
			throw Object.assign(new Error('live market data for this token is temporarily unavailable'), {
				status: 503,
				code: 'data_unavailable',
			});
		}

		const { signal, headline, rationale, confidence } = buildTokenSignal(live);
		const risk = buildTokenRisk(live);
		return {
			mint: live.mint,
			symbol: live.symbol,
			name: live.name,
			chain: live.chain,
			price_usd: live.price_usd,
			change_24h: live.change_24h,
			market_cap_usd: live.market_cap_usd,
			liquidity_usd: live.liquidity_usd,
			volume_24h_usd: live.volume_24h_usd,
			momentum: live.momentum,
			signal,
			headline,
			rationale,
			confidence,
			risk,
			ts: new Date().toISOString(),
		};
	},
});

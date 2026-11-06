// @ts-check
// api/_lib/x402/agents/curator.js
//
// Persona: the Curator — a marketplace/promotion agent.
//
// In character, the Curator keeps the marketplace healthy: it shops skill listings
// (to know what's for sale and at what price) and buys billboard slots to promote
// the platform coin. That is its ring-buyer behaviour — a deterministic rotation
// over the commerce tier (skill-marketplace + billboard). It's the "a curator agent
// buys skill-marketplace listings + billboards" behaviour from the Task 09 brief.
//
// Revenue path (loop closure): both purchases pay the ring treasury
// (X402_PAY_TO_SOLANA). The skill-marketplace call buys the pricing index (a
// platform-owned read); the billboard slot promotes $THREE (the platform's own
// coin — the ONLY coin this platform promotes, per CLAUDE.md). Proceeds land in the
// treasury, show in x402_ring_ledger, and recycle back to the Curator's float via
// ring-rebalance's float-top-up step. Nothing leaves the controlled-wallet set.
//
// The billboard's `coin` is the $THREE mint — the promoted coin — never a
// third-party project. All payment in USDC.

import { priceFor } from '../../x402-prices.js';
import { buildUrl, pickDeterministic } from './persona-kit.js';

// $THREE — the only coin this platform promotes (CLAUDE.md). The Curator's
// billboard advertises it; no other mint is ever hardcoded here.
const THREE_CA = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const CAPTIONS = [
	'gm from the ring',
	'the agent economy runs on $THREE',
	'built on three.ws',
	'live agent-to-agent settlement',
];

export const persona = {
	id: 'curator',
	label: 'Marketplace Curator',
	kind: 'commerce',
	agentName: 'Ring Marketplace Curator',
	describe: 'Shops skill-marketplace listings and buys billboard slots promoting $THREE.',
	// The billboard tier ($0.05) is the priciest routine purchase in the roster, so
	// the per-tx ceiling is set to clear it; the daily ceiling bounds the loop.
	spendLimits: { daily_usd: 8, per_tx_usd: 0.5 },

	/**
	 * Deterministic purchase plan for one tick.
	 * @param {{ origin: string, seed: number, maxBuys?: number }} ctx
	 */
	plan({ origin, seed, maxBuys = 1 }) {
		const caption = CAPTIONS[seed % CAPTIONS.length];
		const actions = [
			{
				slug: 'skill-marketplace', kind: 'commerce', path: '/api/x402/skill-marketplace', method: 'GET',
				priceAtomic: Number(priceFor('skill-marketplace', '1000')), memo: 'curator:shop-listings',
			},
			{
				slug: 'billboard', kind: 'commerce', path: '/api/x402/billboard', method: 'GET',
				query: { coin: THREE_CA, image: 'https://three.ws/og-image.png', caption },
				priceAtomic: Number(priceFor('billboard', '50000')), memo: 'curator:promote-three',
			},
		];
		const chosen = maxBuys >= actions.length ? actions : pickDeterministic(actions, seed, maxBuys);
		return chosen.map((a) => ({
			slug: a.slug,
			url: buildUrl(origin, a.path, a.query),
			method: a.method,
			body: null,
			priceAtomic: a.priceAtomic,
			kind: a.kind,
			memo: a.memo,
		}));
	},
};

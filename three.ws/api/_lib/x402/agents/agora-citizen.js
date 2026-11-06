// @ts-check
// api/_lib/x402/agents/agora-citizen.js
//
// Persona: the Agora Citizen — a working agent who spends its earnings socially.
//
// The agora citizens (workers/agora-citizens/) are real on-chain AgenC agents that
// post, claim, work, and earn. In character, once a citizen finishes a job it
// unwinds at the club: it pays the door cover and tips a dancer. That is its ring-
// buyer behaviour here — a deterministic rotation over the social/tip tier
// (club-cover + dance-tip). It's the "an agora citizen tips dancers and pays club
// cover after completing work" behaviour from the Task 09 brief.
//
// Revenue path (loop closure): both the cover charge and the tip pay the ring
// treasury (X402_PAY_TO_SOLANA) — the club's takings are platform-controlled. The
// dancer is a stage slot on the 3D club stage, not a separate external wallet, so
// the tip never leaves the controlled set: it settles to the treasury, is recorded
// in club_tips (business layer) + x402_ring_ledger (settlement layer), and recycles
// back to this citizen's float via ring-rebalance's float-top-up step.
//
// All USDC. Personas are labeled internal — never presented as organic club-goers.

import { priceFor } from '../../x402-prices.js';
import { buildUrl, pickDeterministic, mulberry32 } from './persona-kit.js';

// Free-floor dance styles the club stage supports (from api/x402/dance-tip.js STYLES).
const DANCE_STYLES = ['rumba', 'silly', 'thriller', 'capoeira', 'hiphop', 'spin', 'climb', 'combo'];

export const persona = {
	id: 'agora-citizen',
	label: 'Agora Citizen',
	kind: 'tip',
	agentName: 'Ring Agora Citizen',
	describe: 'A working AgenC citizen who pays club cover and tips dancers after completing a job.',
	// A citizen tips small and often. Daily ceiling bounds the loop; per-tx covers
	// the $0.01 cover charge with headroom over the $0.001 tips.
	spendLimits: { daily_usd: 3, per_tx_usd: 0.1 },

	/**
	 * Deterministic purchase plan for one tick: pay the door, tip a dancer. The
	 * dancer slot (1-4) and style are chosen deterministically from the seed so the
	 * plan is reproducible.
	 * @param {{ origin: string, seed: number, maxBuys?: number }} ctx
	 */
	plan({ origin, seed, maxBuys = 1 }) {
		const rng = mulberry32(seed ^ 0x9e3779b9);
		const dancer = String(1 + Math.floor(rng() * 4));
		const style = DANCE_STYLES[Math.floor(rng() * DANCE_STYLES.length)];

		const actions = [
			{
				slug: 'club-cover', kind: 'commerce', path: '/api/x402/club-cover', method: 'GET',
				priceAtomic: Number(priceFor('club-cover', '10000')), memo: 'agora-citizen:door',
			},
			{
				slug: 'dance-tip', kind: 'tip', path: '/api/x402/dance-tip', method: 'GET',
				query: { dancer, dance: style },
				priceAtomic: Number(priceFor('dance-tip', '1000')), memo: `agora-citizen:tip:${style}`,
			},
		];

		// A citizen entering the club pays cover first, then tips — deterministic
		// order. When maxBuys clamps to 1, pick one so a single-buy tick still varies.
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

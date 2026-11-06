// Live holder cohorts — for agent tokens that have no coin_holders snapshot.
//
// Agent tokens launched through three.ws live in agent_identities.meta.token
// and are NOT registered in coin_launches, so the snapshot pipeline in
// cohorts.js (which reads coin_holders by coin_id) has nothing to query for
// them. Rather than show empty cohorts, we compute the snapshot-independent
// cohorts directly from the live holder set Helius indexes for the mint
// (fetchHolderBalances → current balances).
//
// What's computable live: anything that needs only CURRENT balances — the full
// holder count, the whale slice (top-fraction by balance), and concentration.
// What's NOT: tenure cohorts (diamond-hands / new-buyers / exited) need
// first_seen / last_seen history, which only exists once a mint is snapshotted.
// Those are reported as `null` (unknown) — never fabricated as zero.
//
// Sampling reuses the same deterministic bucketing as the snapshot path
// (sampleBucket / inSample from cohorts.js), so a "10% of whales" draw is
// stable whether it runs against live data or a snapshot.

import { fetchHolderBalances } from './holders.js';
import { sampleBucket, inSample } from './cohorts.js';
import { cacheGet, cacheSet } from '../cache.js';

// Holder sets change on the order of minutes, but the live path is hit on every
// agent-detail / launch-detail page view — uncached, that meant one full Helius
// DAS getTokenAccounts walk (the highest credit-multiplier method, 1 call per
// 1000 holders) per page load. Caching the resolved set per-mint collapses that
// to at most one walk per mint per TTL regardless of traffic — the single
// largest reduction in Helius credit spend with no change to what users see.
const LIVE_HOLDER_TTL_SECONDS = 180;

// Last-known-good copy kept far longer than the fresh window. It is read ONLY
// when a live Helius DAS walk fails (429 / quota exhausted / outage), so a Helius
// problem degrades the cohorts panel to slightly-stale real data instead of a
// hard 503. getTokenAccounts is Helius-proprietary (the rotating multi-provider
// RPC chain can't serve it), so this stale tier is the failover for this path.
const LIVE_HOLDER_STALE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d

// BigInt can't ride through JSON, so the cached shape stores units as decimal
// strings. These two helpers are the single source of truth for that conversion.
function serializeHolderSet(holders, totalUnits) {
	return {
		holders: holders.map((h) => ({ wallet: h.wallet, units: h.units.toString() })),
		totalUnits: totalUnits.toString(),
	};
}

function deserializeHolderSet(cached) {
	return {
		holders: cached.holders.map((h) => ({ wallet: h.wallet, units: BigInt(h.units) })),
		totalUnits: BigInt(cached.totalUnits),
	};
}

// Cohorts derivable from current balances alone (the rest need snapshot history).
const LIVE_COHORT_IDS = new Set(['holders', 'whales']);

/** True when a cohort can be computed without snapshot history. */
export function isLiveCohort(cohortId) {
	return LIVE_COHORT_IDS.has(cohortId);
}

function numOr(value, fallback) {
	const n = typeof value === 'number' ? value : parseFloat(value);
	return Number.isFinite(n) ? n : fallback;
}

function clampTopPct(value) {
	return Math.min(Math.max(numOr(value, 0.1), 0.0001), 1);
}

// share of a BigInt amount in a BigInt total as a float with ~9 sig digits —
// computed in integer space first so huge supplies never overflow Number.
function shareOf(units, total) {
	if (total <= 0n) return 0;
	return Number((units * 1_000_000_000n) / total) / 1_000_000_000;
}

function round4(x) {
	return Math.round(x * 10000) / 10000;
}

function concentrationLabel(holderCount, top10Share) {
	if (holderCount === 0) return 'none';
	if (top10Share >= 0.8) return 'very-high';
	if (top10Share >= 0.5) return 'high';
	if (top10Share >= 0.25) return 'moderate';
	return 'healthy';
}

// The balance at the top-`topPct` rank. ceil(n × topPct) wallets qualify; ties
// at the boundary are included (so the set is at-least-topPct). Mirrors
// whaleThreshold() in cohorts.js, but over the already-fetched live list.
function whaleCutoff(holders, topPct) {
	if (holders.length === 0) return null;
	const rank = Math.max(1, Math.ceil(holders.length * topPct));
	return holders[Math.min(rank, holders.length) - 1].units;
}

/**
 * Fetch the live holder set for a mint once, sorted by balance desc, with the
 * total supply held. Shared by the counts overview and member export so a
 * single Helius fetch serves both.
 *
 * @param {object} opts
 * @param {string} opts.mint
 * @param {'mainnet'|'devnet'} [opts.network]
 * @returns {Promise<{holders: Array<{wallet:string, units:bigint}>, totalUnits: bigint}>}
 */
export async function liveHolderSet({ mint, network = 'mainnet' }) {
	const cacheKey = `live-holders:${network}:${mint}`;
	const staleKey = `live-holders-stale:${network}:${mint}`;

	// Fresh hit — within the short window, serve straight from cache.
	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached && Array.isArray(cached.holders)) {
		return { ...deserializeHolderSet(cached), stale: false };
	}

	try {
		const balances = await fetchHolderBalances({ mint, network });
		const holders = [...balances.entries()]
			.map(([wallet, units]) => ({ wallet, units }))
			.filter((h) => h.units > 0n)
			.sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0));
		const totalUnits = holders.reduce((sum, h) => sum + h.units, 0n);

		// Don't cache empty results (an unconfigured key or transient RPC failure
		// returns an empty map) — caching a 0-holder set would mask recovery for the
		// whole TTL. A genuinely empty mint is harmless to re-walk; one cheap call.
		if (holders.length > 0) {
			const payload = serializeHolderSet(holders, totalUnits);
			// Fresh cache collapses page-view bursts; the long-lived stale copy is the
			// failover snapshot, refreshed on every successful walk.
			await cacheSet(cacheKey, payload, LIVE_HOLDER_TTL_SECONDS).catch(() => {});
			await cacheSet(staleKey, payload, LIVE_HOLDER_STALE_TTL_SECONDS).catch(() => {});
		}

		return { holders, totalUnits, stale: false };
	} catch (err) {
		// Helius DAS is unreachable (429 / quota / outage). Fall back to the last
		// known-good snapshot so the cohorts panel degrades to stale-but-real data
		// instead of failing. Only rethrow if we have nothing to serve.
		const lastGood = await cacheGet(staleKey).catch(() => null);
		if (lastGood && Array.isArray(lastGood.holders)) {
			console.warn(
				'[cohorts-live] Helius DAS failed for %s — serving last-known-good holder set',
				mint,
			);
			return { ...deserializeHolderSet(lastGood), stale: true };
		}
		throw err;
	}
}

/**
 * Per-cohort counts + concentration computed from a live holder set. Tenure
 * cohorts (diamond-hands / new-buyers / exited) are null — unknown without a
 * snapshot — so callers can render "needs snapshot" instead of a fake 0.
 *
 * @param {{holders: Array, totalUnits: bigint}} set
 * @param {object} [params]  cohort tunables (topPct)
 */
export function liveCohortCounts(set, params = {}) {
	const { holders, totalUnits } = set;
	const holderCount = holders.length;
	const topPct = clampTopPct(params.topPct);

	let whales = 0;
	const cutoff = whaleCutoff(holders, topPct);
	if (cutoff != null) whales = holders.filter((h) => h.units >= cutoff).length;

	const top1Share = holderCount ? shareOf(holders[0].units, totalUnits) : 0;
	const top10Share = holders.slice(0, 10).reduce((s, h) => s + shareOf(h.units, totalUnits), 0);

	return {
		holderCount,
		counts: {
			holders: holderCount,
			whales,
			'diamond-hands': null,
			'new-buyers': null,
			exited: null,
		},
		concentration: {
			top1Share: round4(top1Share),
			top10Share: round4(top10Share),
			label: concentrationLabel(holderCount, top10Share),
		},
	};
}

/**
 * Live member export for a snapshot-independent cohort (holders | whales),
 * sorted by balance desc, with optional deterministic sampling. Throws for
 * tenure cohorts, which require snapshot history.
 *
 * @param {{holders: Array}} set
 * @param {object} opts
 * @param {string} opts.cohortId
 * @param {object} [opts.params]
 * @param {number} [opts.limit]   max members returned (1–1000, default 200)
 * @param {number} [opts.sample]  0–1 fraction to keep via deterministic bucketing
 * @param {string} [opts.salt]    sampling salt (defaults to the mint)
 * @returns {{members: Array, sampled: boolean, total: number, truncated: boolean}}
 */
export function liveCohortMembers(
	set,
	{ cohortId, params = {}, limit = 200, sample, salt = 'live' },
) {
	if (!isLiveCohort(cohortId)) {
		const err = new Error(`cohort "${cohortId}" requires a holder snapshot`);
		err.code = 'snapshot_required';
		throw err;
	}
	let pool = set.holders;
	if (cohortId === 'whales') {
		const cutoff = whaleCutoff(pool, clampTopPct(params.topPct));
		pool = cutoff == null ? [] : pool.filter((h) => h.units >= cutoff);
	}

	const doSample = sample != null && sample > 0 && sample < 1;
	if (doSample) {
		pool = pool.filter((h) => inSample(sampleBucket(h.wallet, cohortId, salt), sample));
	}

	const pageSize = Math.min(Math.max(Math.floor(limit) || 200, 1), 1000);
	const page = pool.slice(0, pageSize);
	return {
		members: page.map((h) => ({
			wallet: h.wallet,
			balance: h.units.toString(),
			firstSeen: null,
			lastSeen: null,
		})),
		sampled: doSample,
		total: pool.length,
		truncated: pool.length > pageSize,
	};
}

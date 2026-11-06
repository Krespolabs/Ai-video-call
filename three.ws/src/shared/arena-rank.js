// Reputation Arena — the pure ordering logic that turns the live agent wall into
// a ranked arena.
//
// Every card on /agents-live carries the agent's REAL, server-computed wallet-
// trust reputation (api/_lib/trust/wallet-reputation.js, surfaced compactly via
// /api/agents/reputation-batch). This module is the single, side-effect-free
// source of truth for HOW those scores order the wall, so the ordering can be
// unit-tested in isolation and never drifts between the wall and any future
// surface that wants the same "arena" sort.
//
// The honest ordering, highest first:
//   1. RATED agents — by trust score (0..100), best on top.
//   2. NEW agents    — a real identity with no track record yet. They rank below
//                      every rated agent (you can't out-rank earned trust by
//                      being new) but above agents whose score hasn't loaded.
//   3. UNKNOWN       — reputation not loaded / unavailable. Always last, so a
//                      slow or failed read sinks rather than jumps the queue.
// Ties keep their original (incoming "popular") order — a stable sort — so the
// wall only ever reorders for a real reputation difference.

// Sentinel arena scores for the non-rated buckets. Kept below any real 0..100
// trust score so a rated agent always outranks a new/unknown one.
export const ARENA_SCORE_NEW = -1;
export const ARENA_SCORE_UNKNOWN = -2;

// Tier → rank, mirroring the server's tier ladder (api/_lib/trust/
// wallet-reputation.js). Used only as a deterministic tie-breaker when two agents
// share an identical rounded score but sit in different tiers; the score itself
// is the primary signal.
export const TIER_RANK = Object.freeze({
	elite: 4,
	trusted: 3,
	established: 2,
	emerging: 1,
	new: 0,
});

/**
 * Map a compact reputation record to a single comparable arena score.
 * Higher sorts earlier. A brand-new agent and an agent with no loaded
 * reputation fall to fixed sentinels below every real score.
 *
 * @param {{score?:number, isNew?:boolean}|null|undefined} rep
 * @returns {number}
 */
export function arenaScore(rep) {
	if (!rep) return ARENA_SCORE_UNKNOWN;
	if (rep.isNew) return ARENA_SCORE_NEW;
	const n = Number(rep.score);
	return Number.isFinite(n) ? n : ARENA_SCORE_UNKNOWN;
}

/**
 * Stable comparator for arena entries. Each entry is `{ rep, index }` where
 * `index` is the agent's original position on the wall (used to keep ties in
 * their incoming order). Sorts by arena score descending, then tier rank
 * descending, then original index ascending.
 *
 * @param {{rep?:object, index?:number}} a
 * @param {{rep?:object, index?:number}} b
 * @returns {number}
 */
export function compareArenaEntries(a, b) {
	const sa = arenaScore(a?.rep);
	const sb = arenaScore(b?.rep);
	if (sa !== sb) return sb - sa;

	const ta = TIER_RANK[a?.rep?.tier] ?? -1;
	const tb = TIER_RANK[b?.rep?.tier] ?? -1;
	if (ta !== tb) return tb - ta;

	return (a?.index ?? 0) - (b?.index ?? 0);
}

/**
 * Order a list of `{ id, rep }` entries into their arena ranking, returning a new
 * array of ids best-first. The input order is treated as the stable tie-break
 * baseline (it is the wall's incoming "popular" order).
 *
 * @param {Array<{id:string, rep?:object}>} entries
 * @returns {string[]} ids in ranked order
 */
export function rankArena(entries) {
	return (entries || [])
		.map((e, index) => ({ id: e.id, rep: e.rep, index }))
		.sort(compareArenaEntries)
		.map((e) => e.id);
}

// Showrunner ranking — the pure, side-effect-free logic that programs the live
// agent wall like a broadcast channel.
//
// /agents-live merges three real signal sources — the server program
// (/api/agents/showrunner: featured pick + notable feed events + popular
// roster), the wall's own live truth (which cards are actually casting a real
// caster frame right now), and fresh per-card events it ingests (a banked
// trade, a completed forge) — into one candidate list. This module is the
// single source of truth for HOW that list is ordered into a spotlight queue +
// grid order, so the ranking can be unit-tested in isolation and never drifts.
//
// The honest priority, highest first:
//   1. LIVE NOW   — a real caster frame within the wall's stale window. A genuinely
//                   casting agent always outranks a mere historical signal.
//   2. NOTABLE    — a recent, attributable event (biggest trade, newest forge,
//                   on-chain verification, milestone), time-decayed so a fresh
//                   one beats a stale one.
//   3. FEATURED   — the deterministic revenue→newest pick.
//   4. POPULAR    — on the wall by real usage; the calm baseline.
// Tiers are spaced so an intra-tier bonus (magnitude + recency) can never lift a
// candidate across a boundary — live always beats notable, notable always beats
// featured, etc. Ties break by recency, then agentId, then incoming order, so the
// program is fully deterministic (never random).

export const TIER_WEIGHT = Object.freeze({ live: 4, notable: 3, featured: 2, popular: 1 });

// Event kinds that count as a "notable" beat (vs the featured/popular baselines).
export const NOTABLE_KINDS = new Set(['trade', 'forge', 'verify', 'milestone']);

// Half-life of a notable event's recency bonus. After this long, the time-decay
// term has fallen to half — a 5-minute-old forge reads as half as urgent as a
// fresh one, and an hour-old one barely registers above the tier floor.
export const DECAY_HALFLIFE_MS = 5 * 60 * 1000;

// Intra-tier bonus must stay strictly below the 1000-point tier spacing so it can
// never cross a boundary. Split between magnitude and recency.
const MAG_WEIGHT = 600;
const RECENCY_WEIGHT = 399;

/**
 * Which tier a candidate falls in. A live overlay (`live: true`) always wins,
 * regardless of the candidate's originating kind — a casting agent that also
 * just traded is ranked as live (keeping its trade caption).
 *
 * @param {{live?:boolean, kind?:string}|null|undefined} c
 * @returns {'live'|'notable'|'featured'|'popular'}
 */
export function tierOf(c) {
	if (!c) return 'popular';
	if (c.live) return 'live';
	if (NOTABLE_KINDS.has(c.kind)) return 'notable';
	if (c.kind === 'featured') return 'featured';
	return 'popular';
}

/**
 * Single comparable score for a candidate. Higher sorts earlier. The integer
 * part is the tier (×1000); the fractional headroom is a magnitude + recency
 * bonus bounded to [0, 999) so it orders within a tier without ever crossing one.
 *
 * @param {object} c       candidate ({ live, kind, magnitude, ts })
 * @param {number} now     epoch ms reference for time-decay
 * @returns {number}
 */
export function candidateScore(c, now) {
	const base = TIER_WEIGHT[tierOf(c)] * 1000;
	const ts = Number(c?.ts) || 0;
	const ageMs = Math.max(0, (Number(now) || 0) - ts);
	const decay = ts ? Math.pow(0.5, ageMs / DECAY_HALFLIFE_MS) : 0;
	const mag = Math.max(0, Number(c?.magnitude) || 0);
	// Diminishing returns: a $2 trade and a $2000 trade both read as "a trade",
	// so magnitude saturates rather than letting one whale dominate the channel.
	const magNorm = mag > 0 ? mag / (mag + 10) : 0;
	const intra = Math.min(999, magNorm * MAG_WEIGHT + decay * RECENCY_WEIGHT);
	return base + intra;
}

/**
 * Rank a merged candidate list into the broadcast program, best-first.
 *
 * Each candidate is `{ agentId, name?, reason?, kind?, magnitude?, ts?, live? }`.
 * Multiple candidates for the same agent (e.g. it's both popular AND just traded)
 * collapse to the single highest-scoring one. A `liveIds` set overlays live truth
 * so the caller doesn't have to mutate the candidates itself.
 *
 * @param {Array<object>} candidates
 * @param {{ now?:number, liveIds?:Set<string>|string[] }} [opts]
 * @returns {Array<object>} deduped candidates in ranked order (each carries `_score`)
 */
export function rankCandidates(candidates, opts = {}) {
	const now = Number(opts.now) || 0;
	const liveIds = opts.liveIds instanceof Set ? opts.liveIds : new Set(opts.liveIds || []);

	const byAgent = new Map();
	(candidates || []).forEach((raw, index) => {
		if (!raw || !raw.agentId) return;
		const c = { ...raw, index, live: !!raw.live || liveIds.has(raw.agentId) };
		c._score = candidateScore(c, now);
		const prev = byAgent.get(c.agentId);
		if (!prev || c._score > prev._score) byAgent.set(c.agentId, c);
	});

	return [...byAgent.values()].sort((a, b) => {
		if (b._score !== a._score) return b._score - a._score;
		const ta = Number(a.ts) || 0;
		const tb = Number(b.ts) || 0;
		if (tb !== ta) return tb - ta;                 // newer first
		if (a.agentId !== b.agentId) return a.agentId < b.agentId ? -1 : 1;
		return a.index - b.index;                      // stable on a true tie
	});
}

/**
 * Convenience: the ranked agentId order (the grid program).
 * @param {Array<object>} candidates
 * @param {object} [opts]
 * @returns {string[]}
 */
export function programOrder(candidates, opts) {
	return rankCandidates(candidates, opts).map((c) => c.agentId);
}

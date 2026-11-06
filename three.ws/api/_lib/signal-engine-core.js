// Signal marketplace engine — PURE core (no DB, no network, no SDK imports).
//
// Split out from signal-engine.js so the outcome classification, conviction +
// sizing math, and the confidence-regressed feed-edge score can be reasoned about
// and tested in isolation — without dragging in the DB client, Solana web3, or the
// pump SDK that the delivery half depends on. signal-engine.js re-exports every
// symbol here, so production callers import from one place as before.
//
// Honesty rules baked in (same spirit as trader-stats):
//   - A feed's rank is its PROVEN realized edge, regressed toward neutral (and the
//     publisher's own track-record score) until enough signals have closed — a
//     thin feed with one lucky call can never top a deep, consistent one.
//   - Realized outcomes count losers; nothing is hidden.

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const lamToSol = (l) => (l == null ? 0 : Number(BigInt(l)) / LAMPORTS_PER_SOL);
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// --- Edge-score tuning. Transparent, named, tunable (cf. trader-stats). --------
export const EDGE_WEIGHTS = { hitRate: 0.55, roi: 0.45 };
export const EDGE_CONFIDENCE_FULL_AT = 10;  // closed signals for full statistical confidence
export const EDGE_NEUTRAL = 0.45;           // unproven feeds regress toward this (slightly below mid)
export const ROI_TANH_PCT = 50;             // ~+50% avg realized ≈ a strongly positive ROI sub-score
export const FLAT_OUTCOME_PCT = 1;          // |realized| ≤ this counts as flat, not win/loss
export const DUST_ORDER_SOL = 0.002;        // mirror orders below this are skipped as dust

/** Realized P&L pct → win / loss / flat. A near-zero result is flat, not a win. */
export function classifyOutcome(realizedPnlPct) {
	if (realizedPnlPct == null || !Number.isFinite(Number(realizedPnlPct))) return null;
	const pct = Number(realizedPnlPct);
	if (pct > FLAT_OUTCOME_PCT) return 'win';
	if (pct < -FLAT_OUTCOME_PCT) return 'loss';
	return 'flat';
}

/** This entry's size relative to the publisher's typical (median) entry. 1.0 = typical. */
export function computeSizeMultiple(entrySol, referenceEntrySol) {
	const ref = Number(referenceEntrySol);
	const entry = Number(entrySol);
	if (!(ref > 0) || !(entry > 0)) return 1;
	return Number((entry / ref).toFixed(4));
}

/**
 * Conviction (0..1) from how large a bet this is vs the trader's norm. A trader
 * sizing 3× their typical entry is maximally convicted; their typical entry sits
 * near 0.33. Documented heuristic — bound to real sizing data, never declared.
 */
export function computeConviction(sizeMultiple) {
	const m = Number(sizeMultiple);
	if (!(m > 0)) return 0;
	return Number(clamp(m / 3, 0, 1).toFixed(3));
}

/**
 * The subscriber's mirrored order size (SOL) for an entry:
 *   base_sol × size_multiple × size_scaling, hard-capped at max_per_trade_sol.
 * Returns 0 when the sized order is dust (the caller skips it).
 */
export function subscriberOrderSol({ baseSol, sizeMultiple, sizeScaling = 1, maxPerTradeSol }) {
	const sized = Number(baseSol) * Number(sizeMultiple || 1) * Number(sizeScaling || 1);
	const capped = clamp(sized, 0, Number(maxPerTradeSol) || sized);
	return capped < DUST_ORDER_SOL ? 0 : Number(capped.toFixed(6));
}

/**
 * A feed's proven realized edge (0–100), confidence-regressed. Until a feed has
 * EDGE_CONFIDENCE_FULL_AT closed signals, its score is pulled toward a neutral
 * blended with the publisher's own verified track-record score — so a strong
 * trader's new feed isn't punished to neutral, but still must PROVE per-feed edge
 * before it can top the board.
 */
export function feedEdgeScore({ closedSignals, winningSignals, avgRealizedPct, publisherScore = 50 }) {
	const closed = Number(closedSignals) || 0;
	const hitRate = closed > 0 ? clamp((Number(winningSignals) || 0) / closed, 0, 1) : 0;
	const roiComponent = 0.5 + 0.5 * Math.tanh((Number(avgRealizedPct) || 0) / ROI_TANH_PCT);
	const raw = clamp(EDGE_WEIGHTS.hitRate * hitRate + EDGE_WEIGHTS.roi * roiComponent, 0, 1);
	const confidence = clamp(closed / EDGE_CONFIDENCE_FULL_AT, 0, 1);
	const prior = clamp((Number(publisherScore) || 50) / 100, 0, 1);
	const neutral = (EDGE_NEUTRAL + prior) / 2;
	const effective = raw * confidence + neutral * (1 - confidence);
	return Math.round(100 * clamp(effective, 0, 1));
}

export const FEED_SORTS = new Set(['edge', 'roi', 'hitrate', 'subscribers', 'newest']);

const FEED_COMPARATORS = {
	edge: (a, b) => b.edge_score - a.edge_score || b.closed_signals - a.closed_signals,
	roi: (a, b) => (b.avg_realized_pct ?? -1e9) - (a.avg_realized_pct ?? -1e9) || b.edge_score - a.edge_score,
	hitrate: (a, b) => (b.hit_rate ?? -1) - (a.hit_rate ?? -1) || b.closed_signals - a.closed_signals,
	subscribers: (a, b) => b.subscribers - a.subscribers || b.edge_score - a.edge_score,
	newest: (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
};

/** Sort an already-scored feed list by the chosen key. Pure. */
export function rankFeeds(feeds, sort = 'edge') {
	const cmp = FEED_COMPARATORS[sort] || FEED_COMPARATORS.edge;
	return [...feeds].sort(cmp).map((f, i) => ({ rank: i + 1, ...f }));
}

/** Median of a numeric array (0 for empty). */
export function median(values) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

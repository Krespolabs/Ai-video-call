// mm-render.js — pure mapping from a market-maker engine outcome to the render
// layer.
//
// One place owns: the screen `action_type` + holder-readable `summary` persisted
// on the ledger, the structured `context` the arena reads to draw the floor line
// and trigger emotes, and the SOL-unit normalization the worker and the arena
// share. No DOM, no Three.js, no DB, no chain — safe to import from the worker,
// the browser arena, and unit tests alike. The render layer never signs or moves
// funds; it only describes what a sweep already decided.

// engine `kind` (the tag runPolicy returns for a fired action) → screen action_type.
const KIND_TO_ACTION_TYPE = {
	seed: 'mm_seed',
	defend_buy: 'mm_defend',
	recycle_sell: 'mm_recycle',
	rebalance_trim: 'mm_rebalance',
	graduation_lp: 'mm_graduate',
	graduation_distribute: 'mm_graduate',
	graduation_hold: 'mm_quote',
};

// The full set of screen action_types this feature emits (durable + live).
export const MM_ACTION_TYPES = ['mm_seed', 'mm_defend', 'mm_recycle', 'mm_rebalance', 'mm_graduate', 'mm_quote'];

// Outcomes that represent a REAL fill the arena celebrates with an emote + earns
// a permanent agent_actions row. Everything else (quotes, guards, holds) is a
// live-only floor/price update — it moves the marker but writes no ledger row.
const FIRED_KINDS = new Set(['seed', 'defend_buy', 'recycle_sell', 'rebalance_trim', 'graduation_lp', 'graduation_distribute']);

/** Map an engine outcome tag to its screen action_type (defaults to mm_quote). */
export function mmActionType(kind) {
	return KIND_TO_ACTION_TYPE[kind] || 'mm_quote';
}

/** True when the tag is a real fill (emote + persisted row); false for quotes/guards. */
export function isFiredKind(kind) {
	return FIRED_KINDS.has(kind);
}

// ── unit normalization ────────────────────────────────────────────────────────

function finite(n) {
	const v = Number(n);
	return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Clamp floor + price to the same finite, non-negative SOL units the arena draws
 * the line in. The renderer trusts the output: no NaN, no negatives, no strings.
 */
export function normalizeFloor({ floorSol, priceSol } = {}) {
	return { floorSol: finite(floorSol), priceSol: finite(priceSol) };
}

// ── holder-readable formatting ────────────────────────────────────────────────

/** SOL size with adaptive precision: 0.40, 0.024, 0.0015. */
export function fmtSizeSol(n) {
	const v = finite(n);
	if (v === 0) return '0';
	if (v >= 0.1) return v.toFixed(2);
	if (v >= 0.01) return v.toFixed(3);
	return v.toFixed(4);
}

/** A tiny token price with ~3 significant digits: 0.0000142, 0.00031, 1.4200. */
export function fmtPriceSol(n) {
	const v = finite(n);
	if (v === 0) return '0';
	if (v >= 1) return v.toFixed(4);
	// Keep ~3 significant figures past the leading zeros.
	const digits = Math.min(12, Math.max(4, Math.ceil(-Math.log10(v)) + 3));
	return v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

const SUMMARY = {
	mm_seed: (s) => `Seeded liquidity: bought ${s.size} SOL`,
	mm_defend: (s) => `Defended floor: bought ${s.size} SOL at ${s.price}`,
	mm_recycle: (s) => `Recycled profit: sold ${s.size} SOL at ${s.price}`,
	mm_rebalance: (s) => `Rebalanced inventory: sold ${s.size} SOL at ${s.price}`,
	mm_graduate: (s) => `Graduated — provided LP (${s.size} SOL)`,
	mm_quote: (s) => `Quoting two-sided · floor ${s.floor} · price ${s.price}`,
};

/** Build the plain-language one-liner shown in the activity log + card badge. */
export function mmSummary({ actionType, sizeSol, priceSol, floorSol, simulate } = {}) {
	const parts = { size: fmtSizeSol(sizeSol), price: fmtPriceSol(priceSol), floor: fmtPriceSol(floorSol) };
	const base = (SUMMARY[actionType] || SUMMARY.mm_quote)(parts);
	return simulate ? `${base} (sim)` : base;
}

// ── outcome → screen event ────────────────────────────────────────────────────

/**
 * Turn an enriched engine outcome ({ tag, mint, floorSol, priceSol, sizeSol,
 * sideBuy, signature, simulate }) into the screen event the worker persists +
 * publishes: { actionType, summary, context }. `context` is the structured
 * payload the arena reads to draw the floor line and route emotes — normalized
 * to render-safe primitives so a malformed sweep can never poison a viewer.
 */
export function mmEventFromOutcome(outcome = {}) {
	const { tag, mint, floorSol, priceSol, sizeSol, sideBuy, signature, simulate } = outcome;
	const actionType = mmActionType(tag);
	const norm = normalizeFloor({ floorSol, priceSol });
	const context = {
		mint: typeof mint === 'string' ? mint.slice(0, 64) : null,
		floorSol: norm.floorSol,
		priceSol: norm.priceSol,
		sizeSol: finite(sizeSol),
		sideBuy: sideBuy === true ? true : sideBuy === false ? false : null,
		simulate: !!simulate,
		signature: typeof signature === 'string' && signature !== 'SIMULATED' ? signature.slice(0, 96) : null,
	};
	const summary = mmSummary({
		actionType, sizeSol: context.sizeSol, priceSol: context.priceSol,
		floorSol: context.floorSol, simulate: context.simulate,
	});
	return { actionType, summary, context };
}

/**
 * Whitelist + coerce an inbound `mm` ride-along (from a frame/log entry) into the
 * render context shape. The transport may carry an extra `type` field; keep it.
 * Returns null when the payload is unusable so a bad push can't drive the arena.
 */
export function sanitizeMmEvent(mm) {
	if (!mm || typeof mm !== 'object') return null;
	const type = MM_ACTION_TYPES.includes(mm.type) ? mm.type : null;
	const norm = normalizeFloor({ floorSol: mm.floorSol, priceSol: mm.priceSol });
	const out = {
		type: type || 'mm_quote',
		floorSol: norm.floorSol,
		priceSol: norm.priceSol,
		sizeSol: finite(mm.sizeSol),
		sideBuy: mm.sideBuy === true ? true : mm.sideBuy === false ? false : null,
		simulate: !!mm.simulate,
	};
	if (typeof mm.mint === 'string') out.mint = mm.mint.slice(0, 64);
	if (typeof mm.signature === 'string') out.signature = mm.signature.slice(0, 96);
	return out;
}

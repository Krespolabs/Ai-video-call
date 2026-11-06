// trade-pnl.js — pure helpers for the Live Trading Desk PnL ticker + avatar emote.
//
// No DOM, no network, no time: the agent-screen UI imports these to fold real
// trade frames into a running session total and to map an exit's sign onto an
// avatar gesture. Kept pure so tests/agent-screen-pnl.test.js can exercise the
// accumulator and emote mapping directly in node.
//
// A 'trade' frame may carry an optional `pnl` payload shaped by the sniper
// executor:
//   { phase: 'scored'|'buy'|'hold'|'exit', mint, symbol, solDelta, pct,
//     realizedUsd, unrealizedUsd }
// Only `exit` frames move the realized total; `hold` frames replace the live
// unrealized mark for a single mint. Everything else is narration only.

const PHASES = ['scored', 'buy', 'hold', 'exit'];

function finite(v) {
	// null / undefined / '' mean "absent" — not 0 (Number(null) === 0 would
	// otherwise mask a missing solDelta and defeat the realizedUsd fallback).
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a raw `pnl` payload into a typed delta, or null when the frame
 * carries no usable PnL signal. Trusts nothing: every number is coerced and
 * NaN/∞ are dropped to null so a malformed push can never poison the ticker.
 * @param {any} pnl
 * @returns {{phase:string, mint:string|null, symbol:string|null, solDelta:number|null, pct:number|null, realizedUsd:number|null, unrealizedUsd:number|null}|null}
 */
export function parsePnlDelta(pnl) {
	if (!pnl || typeof pnl !== 'object') return null;
	if (!PHASES.includes(pnl.phase)) return null;
	return {
		phase: pnl.phase,
		mint: typeof pnl.mint === 'string' ? pnl.mint : null,
		symbol: typeof pnl.symbol === 'string' ? pnl.symbol : null,
		solDelta: finite(pnl.solDelta),
		pct: finite(pnl.pct),
		realizedUsd: finite(pnl.realizedUsd),
		unrealizedUsd: finite(pnl.unrealizedUsd),
	};
}

/** A fresh, zeroed session accumulator. */
export function emptyPnlState() {
	return {
		realizedUsd: 0,
		realizedSol: 0,
		unrealizedByMint: {}, // mint → live unrealized USD (last 'hold' mark)
		trades: 0,
		wins: 0,
		losses: 0,
	};
}

/**
 * Fold a typed delta into the running session totals, returning a NEW state
 * (never mutates the input). Only realized exits move the realized total and
 * the win/loss tally; a 'hold' replaces that mint's unrealized mark; a closed
 * position drops its unrealized mark so it isn't double-counted with realized.
 * @param {object} state
 * @param {ReturnType<typeof parsePnlDelta>} delta
 */
export function accumulatePnl(state, delta) {
	const base = state || emptyPnlState();
	const next = {
		realizedUsd: base.realizedUsd || 0,
		realizedSol: base.realizedSol || 0,
		unrealizedByMint: { ...(base.unrealizedByMint || {}) },
		trades: base.trades || 0,
		wins: base.wins || 0,
		losses: base.losses || 0,
	};
	if (!delta) return next;

	if (delta.phase === 'exit') {
		if (delta.realizedUsd != null) next.realizedUsd += delta.realizedUsd;
		if (delta.solDelta != null) next.realizedSol += delta.solDelta;
		if (delta.mint) delete next.unrealizedByMint[delta.mint];
		next.trades += 1;
		const sign = delta.solDelta != null ? delta.solDelta : delta.realizedUsd;
		if (sign != null && sign > 0) next.wins += 1;
		else if (sign != null && sign < 0) next.losses += 1;
	} else if (delta.phase === 'hold' && delta.mint && delta.unrealizedUsd != null) {
		next.unrealizedByMint[delta.mint] = delta.unrealizedUsd;
	}
	return next;
}

/** Sum of every open position's live unrealized USD mark. */
export function unrealizedTotalUsd(state) {
	const marks = state?.unrealizedByMint || {};
	return Object.values(marks).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * Map an exit's sign onto the avatar gesture. Wins celebrate, losses slump
 * (the manifest's 'defeated' clip), breakeven and non-exit frames never emote.
 * @param {ReturnType<typeof parsePnlDelta>} delta
 * @returns {'celebrate'|'defeated'|null}
 */
export function emoteForExit(delta) {
	if (!delta || delta.phase !== 'exit') return null;
	const v = delta.solDelta != null ? delta.solDelta : delta.realizedUsd;
	if (v == null || v === 0) return null;
	return v > 0 ? 'celebrate' : 'defeated';
}

/** Format a signed SOL amount for the ticker, e.g. +0.0123 / -0.0045. */
export function formatSol(sol) {
	if (!Number.isFinite(sol)) return '—';
	const sign = sol > 0 ? '+' : sol < 0 ? '−' : '';
	return `${sign}${Math.abs(sol).toFixed(4)} SOL`;
}

/** Format a signed USD amount for the ticker, e.g. +$12.40 / -$3.05. */
export function formatUsd(usd) {
	if (!Number.isFinite(usd)) return null;
	const sign = usd > 0 ? '+' : usd < 0 ? '−' : '';
	const abs = Math.abs(usd);
	const digits = abs >= 100 ? 0 : 2;
	return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

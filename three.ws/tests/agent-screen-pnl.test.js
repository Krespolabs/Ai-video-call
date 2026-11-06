// Live Trading Desk — unit tests for the pure PnL accumulator + emote mapping.
//
// These cover the only logic the viewer's ticker depends on: folding real trade
// frames into a running session total, and mapping an exit's sign onto the
// avatar gesture. No DOM, no network — just the pure helpers.

import { describe, it, expect } from 'vitest';
import {
	parsePnlDelta,
	accumulatePnl,
	emptyPnlState,
	unrealizedTotalUsd,
	emoteForExit,
	formatSol,
	formatUsd,
} from '../src/shared/trade-pnl.js';

describe('parsePnlDelta', () => {
	it('rejects non-objects and unknown phases', () => {
		expect(parsePnlDelta(null)).toBe(null);
		expect(parsePnlDelta(42)).toBe(null);
		expect(parsePnlDelta({})).toBe(null);
		expect(parsePnlDelta({ phase: 'nope' })).toBe(null);
	});

	it('coerces numbers and drops non-finite values to null', () => {
		const d = parsePnlDelta({ phase: 'exit', mint: 'm', symbol: 'X', solDelta: '0.5', pct: 'NaN', realizedUsd: Infinity });
		expect(d).toEqual({ phase: 'exit', mint: 'm', symbol: 'X', solDelta: 0.5, pct: null, realizedUsd: null, unrealizedUsd: null });
	});

	it('keeps only string mint/symbol', () => {
		const d = parsePnlDelta({ phase: 'buy', mint: 123, symbol: { x: 1 } });
		expect(d.mint).toBe(null);
		expect(d.symbol).toBe(null);
	});
});

describe('accumulatePnl', () => {
	it('starts from an empty state and adds a realized win', () => {
		const s = accumulatePnl(emptyPnlState(), parsePnlDelta({ phase: 'exit', mint: 'a', solDelta: 0.02, realizedUsd: 4 }));
		expect(s.realizedSol).toBeCloseTo(0.02, 9);
		expect(s.realizedUsd).toBeCloseTo(4, 9);
		expect(s.trades).toBe(1);
		expect(s.wins).toBe(1);
		expect(s.losses).toBe(0);
	});

	it('tallies a realized loss', () => {
		const s = accumulatePnl(emptyPnlState(), parsePnlDelta({ phase: 'exit', mint: 'a', solDelta: -0.01, realizedUsd: -2 }));
		expect(s.realizedSol).toBeCloseTo(-0.01, 9);
		expect(s.wins).toBe(0);
		expect(s.losses).toBe(1);
	});

	it('breakeven exits count as a trade but neither win nor loss', () => {
		const s = accumulatePnl(emptyPnlState(), parsePnlDelta({ phase: 'exit', mint: 'a', solDelta: 0 }));
		expect(s.trades).toBe(1);
		expect(s.wins).toBe(0);
		expect(s.losses).toBe(0);
	});

	it('sums multiple exits across a session', () => {
		let s = emptyPnlState();
		s = accumulatePnl(s, parsePnlDelta({ phase: 'exit', mint: 'a', solDelta: 0.02, realizedUsd: 4 }));
		s = accumulatePnl(s, parsePnlDelta({ phase: 'exit', mint: 'b', solDelta: -0.005, realizedUsd: -1 }));
		s = accumulatePnl(s, parsePnlDelta({ phase: 'exit', mint: 'c', solDelta: 0.01, realizedUsd: 2 }));
		expect(s.realizedSol).toBeCloseTo(0.025, 9);
		expect(s.realizedUsd).toBeCloseTo(5, 9);
		expect(s.trades).toBe(3);
		expect(s.wins).toBe(2);
		expect(s.losses).toBe(1);
	});

	it('hold frames replace a mint unrealized mark; exit clears it', () => {
		let s = emptyPnlState();
		s = accumulatePnl(s, parsePnlDelta({ phase: 'hold', mint: 'a', unrealizedUsd: 3 }));
		expect(unrealizedTotalUsd(s)).toBeCloseTo(3, 9);
		s = accumulatePnl(s, parsePnlDelta({ phase: 'hold', mint: 'a', unrealizedUsd: 7 })); // replace, not add
		expect(unrealizedTotalUsd(s)).toBeCloseTo(7, 9);
		s = accumulatePnl(s, parsePnlDelta({ phase: 'hold', mint: 'b', unrealizedUsd: 2 }));
		expect(unrealizedTotalUsd(s)).toBeCloseTo(9, 9);
		s = accumulatePnl(s, parsePnlDelta({ phase: 'exit', mint: 'a', solDelta: 0.01, realizedUsd: 5 }));
		expect(unrealizedTotalUsd(s)).toBeCloseTo(2, 9); // a's mark cleared, b's remains
	});

	it('does not mutate the previous state', () => {
		const prev = emptyPnlState();
		const next = accumulatePnl(prev, parsePnlDelta({ phase: 'exit', mint: 'a', solDelta: 0.02, realizedUsd: 4 }));
		expect(prev.realizedSol).toBe(0);
		expect(prev.trades).toBe(0);
		expect(next).not.toBe(prev);
	});

	it('ignores a null delta (no-op fold)', () => {
		const s = accumulatePnl(emptyPnlState(), null);
		expect(s).toEqual(emptyPnlState());
	});
});

describe('emoteForExit', () => {
	it('celebrates a profitable exit', () => {
		expect(emoteForExit(parsePnlDelta({ phase: 'exit', solDelta: 0.02 }))).toBe('celebrate');
		expect(emoteForExit(parsePnlDelta({ phase: 'exit', solDelta: null, realizedUsd: 5 }))).toBe('celebrate');
	});

	it('slumps on a losing exit', () => {
		expect(emoteForExit(parsePnlDelta({ phase: 'exit', solDelta: -0.01 }))).toBe('defeated');
		expect(emoteForExit(parsePnlDelta({ phase: 'exit', solDelta: null, realizedUsd: -3 }))).toBe('defeated');
	});

	it('does not emote on breakeven, non-exits, or null', () => {
		expect(emoteForExit(parsePnlDelta({ phase: 'exit', solDelta: 0 }))).toBe(null);
		expect(emoteForExit(parsePnlDelta({ phase: 'buy', solDelta: -0.05 }))).toBe(null);
		expect(emoteForExit(parsePnlDelta({ phase: 'scored' }))).toBe(null);
		expect(emoteForExit(null)).toBe(null);
	});

	it('prefers solDelta over realizedUsd for the sign', () => {
		// solDelta positive wins even if a stale USD value disagrees
		expect(emoteForExit(parsePnlDelta({ phase: 'exit', solDelta: 0.01, realizedUsd: -100 }))).toBe('celebrate');
	});
});

describe('formatters', () => {
	it('formats signed SOL with a minus glyph and 4 decimals', () => {
		expect(formatSol(0.0123)).toBe('+0.0123 SOL');
		expect(formatSol(-0.0045)).toBe('−0.0045 SOL');
		expect(formatSol(0)).toBe('0.0000 SOL');
		expect(formatSol(Infinity)).toBe('—');
	});

	it('formats signed USD and drops cents above $100', () => {
		expect(formatUsd(12.4)).toBe('+$12.40');
		expect(formatUsd(-3.05)).toBe('−$3.05');
		expect(formatUsd(250)).toBe('+$250');
		expect(formatUsd(NaN)).toBe(null);
	});
});

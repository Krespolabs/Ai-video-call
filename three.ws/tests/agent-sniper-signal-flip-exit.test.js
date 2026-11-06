/**
 * agent-sniper — signal_flip exit (paid-intel-driven early loss cut).
 *
 * decideExit gains an optional `sentiment` arg. These lock in that:
 *   - it stays inert when omitted (backtester / existing callers unchanged),
 *   - a confident bearish flip cuts an UNDERWATER position before the stop,
 *   - it never overrides the hard stop-loss, a take-profit, or a winner,
 *   - the confidence floor is honoured.
 * decideExit is pure (no DB, no I/O), so this needs no fixtures.
 */

import { describe, it, expect } from 'vitest';
import { decideExit } from '../workers/agent-sniper/exit-logic.js';

const EV = 1_000_000_000; // 1 SOL entry, in lamports
const basePos = {
	entry_quote_lamports: String(EV),
	stop_loss_pct: 30,
	trailing_stop_pct: null,
	take_profit_pct: 100,
	max_hold_seconds: 3600,
	opened_at: new Date(Date.now() - 60_000).toISOString(),
};

const bearish = (confidence) => ({ signal: 'bearish', confidence, minConfidence: 0.7 });

describe('decideExit — signal_flip', () => {
	it('is inert when no sentiment is passed (replay/backtest path)', () => {
		// 10% underwater, above the 30% stop — would hold without sentiment.
		expect(decideExit(basePos, 0.9 * EV, EV)).toBe(null);
	});

	it('cuts an underwater position on a confident bearish flip', () => {
		expect(decideExit(basePos, 0.9 * EV, EV, Date.now(), bearish(0.85))).toBe('signal_flip');
	});

	it('does not fire on a position that is in profit', () => {
		expect(decideExit(basePos, 1.2 * EV, 1.2 * EV, Date.now(), bearish(0.95))).toBe(null);
	});

	it('respects the confidence floor', () => {
		expect(decideExit(basePos, 0.9 * EV, EV, Date.now(), bearish(0.5))).toBe(null);
	});

	it('never overrides the hard stop-loss', () => {
		// 40% down is past the 30% stop — stop_loss must win even with a bearish flip.
		expect(decideExit(basePos, 0.6 * EV, EV, Date.now(), bearish(0.99))).toBe('stop_loss');
	});

	it('ignores a bullish/neutral signal', () => {
		expect(decideExit(basePos, 0.9 * EV, EV, Date.now(), { signal: 'bullish', confidence: 0.99, minConfidence: 0.7 })).toBe(null);
		expect(decideExit(basePos, 0.9 * EV, EV, Date.now(), { signal: 'neutral', confidence: 0.99, minConfidence: 0.7 })).toBe(null);
	});
});

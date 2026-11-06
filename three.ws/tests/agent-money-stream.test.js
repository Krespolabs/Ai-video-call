// Money Streams — the accrual + ceiling math that backs pay-per-second income.
//
// The single money-safety invariant a streamer signs for is `maxTotal`: no matter
// how long a stream runs or how high the rate, the amount projected/owed can never
// exceed the ceiling. accruedHuman() is the pure function the live meter and the
// settlement loop both derive from, so these tests pin that guarantee.

import { describe, it, expect } from 'vitest';
import { accruedHuman, STREAM_ASSETS } from '../src/shared/agent-money-stream.js';

describe('accruedHuman · per-second accrual', () => {
	it('accrues linearly with active time at the chosen rate', () => {
		// 0.06 SOL/min = 0.001 SOL/sec. 30s of active time → 0.03 SOL.
		expect(accruedHuman({ ratePerMinute: 0.06, activeMs: 30_000, maxTotal: 1 })).toBeCloseTo(0.03, 9);
		// One full minute → exactly the per-minute rate.
		expect(accruedHuman({ ratePerMinute: 0.25, activeMs: 60_000, maxTotal: 100 })).toBeCloseTo(0.25, 9);
	});

	it('never exceeds the signed ceiling, however long it runs', () => {
		// 1 SOL/min for an hour would be 60 SOL, but the cap is 0.5.
		expect(accruedHuman({ ratePerMinute: 1, activeMs: 3_600_000, maxTotal: 0.5 })).toBe(0.5);
		// Exactly at the cap stays at the cap.
		expect(accruedHuman({ ratePerMinute: 1, activeMs: 30_000, maxTotal: 0.5 })).toBe(0.5);
	});

	it('returns 0 before any active time and for a zero/negative rate', () => {
		expect(accruedHuman({ ratePerMinute: 0.5, activeMs: 0, maxTotal: 10 })).toBe(0);
		expect(accruedHuman({ ratePerMinute: 0, activeMs: 60_000, maxTotal: 10 })).toBe(0);
		expect(accruedHuman({ ratePerMinute: -1, activeMs: 60_000, maxTotal: 10 })).toBe(0);
	});

	it('treats a missing/invalid cap as uncapped (the engine always passes a real cap)', () => {
		expect(accruedHuman({ ratePerMinute: 0.1, activeMs: 60_000, maxTotal: 0 })).toBeCloseTo(0.1, 9);
		expect(accruedHuman({ ratePerMinute: 0.1, activeMs: 60_000, maxTotal: NaN })).toBeCloseTo(0.1, 9);
	});
});

describe('STREAM_ASSETS · supported rails', () => {
	it('offers SOL and USDC with sane per-minute presets', () => {
		const ids = STREAM_ASSETS.map((a) => a.id);
		expect(ids).toContain('SOL');
		expect(ids).toContain('USDC');
		for (const a of STREAM_ASSETS) {
			expect(a.ratePresets.length).toBeGreaterThan(0);
			expect(a.ratePresets.every((p) => p > 0)).toBe(true);
		}
	});
});

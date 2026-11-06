// Pure GPS-lifecycle helpers (src/irl/gps-lifecycle.js).
//
// These pin two contracts the live AR code in src/irl.js depends on but can't
// easily exercise on CI: telling the truth about a fix's accuracy, and the eased
// progress that glides the camera from the gyro pivot to the precise GPS anchor on
// the local→GPS lock upgrade. Both are plain numbers in / numbers out — no DOM, no
// Three.js, no clock — so the math is proven here directly.

import { describe, it, expect } from 'vitest';

import {
	gpsAccuracyBucket,
	easeGpsTransition,
	GPS_ACCURACY_PRECISE_M,
	GPS_ACCURACY_COARSE_M,
	GPS_TRANSITION_MS,
} from '../src/irl/gps-lifecycle.js';

describe('gpsAccuracyBucket', () => {
	it('treats a tight fix (≤ threshold) as precise with no hint label', () => {
		for (const m of [0, 5, 12, GPS_ACCURACY_PRECISE_M]) {
			const b = gpsAccuracyBucket(m);
			expect(b.level).toBe('precise');
			expect(b.precise).toBe(true);
			expect(b.label).toBe('');
			expect(b.accuracyM).toBe(Math.round(m));
		}
	});

	it('flags a mid-range fix as approximate and never claims precision', () => {
		const b = gpsAccuracyBucket(40);
		expect(b.level).toBe('approximate');
		expect(b.precise).toBe(false);
		expect(b.label).toContain('40');
		expect(b.accuracyM).toBe(40);
	});

	it('flags a very noisy fix (> coarse threshold) as coarse with a low-accuracy note', () => {
		const b = gpsAccuracyBucket(GPS_ACCURACY_COARSE_M + 30);
		expect(b.level).toBe('coarse');
		expect(b.precise).toBe(false);
		expect(b.label.toLowerCase()).toContain('low');
		expect(b.accuracyM).toBe(GPS_ACCURACY_COARSE_M + 30);
	});

	it('rounds the displayed metres but keeps the bucket boundary on the raw value', () => {
		// 25.4 m rounds to 25 for display yet is past the precise threshold, so it must
		// NOT be claimed precise — the boundary is tested against the raw reading.
		const b = gpsAccuracyBucket(25.4);
		expect(b.precise).toBe(false);
		expect(b.accuracyM).toBe(25);
	});

	it('returns unknown (never precise, no label) for a missing/invalid reading', () => {
		for (const v of [null, undefined, NaN, -1]) {
			const b = gpsAccuracyBucket(v);
			expect(b.level).toBe('unknown');
			expect(b.precise).toBe(false);
			expect(b.label).toBe('');
			expect(b.accuracyM).toBe(null);
		}
	});
});

describe('easeGpsTransition', () => {
	it('pins the endpoints exactly', () => {
		expect(easeGpsTransition(0)).toBe(0);
		expect(easeGpsTransition(1)).toBe(1);
	});

	it('clamps out-of-range progress so a long frame or paused tab cannot overshoot', () => {
		expect(easeGpsTransition(-0.5)).toBe(0);
		expect(easeGpsTransition(1.4)).toBe(1);
		expect(easeGpsTransition(NaN)).toBe(0);
	});

	it('eases out — fast at the start, gentle at the end, always within [0,1]', () => {
		const mid = easeGpsTransition(0.5);
		expect(mid).toBeGreaterThan(0.5);   // ease-out is ahead of linear at the midpoint
		expect(mid).toBeLessThan(1);
		// Monotonic increase across the curve.
		let prev = -1;
		for (let t = 0; t <= 1.0001; t += 0.1) {
			const e = easeGpsTransition(t);
			expect(e).toBeGreaterThanOrEqual(prev);
			expect(e).toBeGreaterThanOrEqual(0);
			expect(e).toBeLessThanOrEqual(1);
			prev = e;
		}
	});

	it('reaches 1 exactly when elapsed hits the configured duration', () => {
		expect(easeGpsTransition(GPS_TRANSITION_MS / GPS_TRANSITION_MS)).toBe(1);
	});
});

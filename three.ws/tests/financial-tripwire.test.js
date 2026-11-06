import { describe, it, expect } from 'vitest';
import { evaluateTripwire } from '../api/_lib/financial-tripwire.js';

// The alarm that was missing when the ring quietly died: a money loop that is
// configured-active but has gone silent past its window must be flagged.

const WINDOW = 60 * 60_000; // 60 min
const NOW = 1_000_000_000_000;

describe('evaluateTripwire', () => {
	it('is not silent when the subsystem is disabled (no false alarms)', () => {
		expect(evaluateTripwire({ configured: false, lastActivityMs: null, windowMs: WINDOW, now: NOW }))
			.toEqual({ silent: false, ageMinutes: null });
	});

	it('is SILENT when configured but never active (strongest signal)', () => {
		expect(evaluateTripwire({ configured: true, lastActivityMs: null, windowMs: WINDOW, now: NOW }))
			.toEqual({ silent: true, ageMinutes: null });
	});

	it('is not silent when activity is within the window', () => {
		const v = evaluateTripwire({ configured: true, lastActivityMs: NOW - 10 * 60_000, windowMs: WINDOW, now: NOW });
		expect(v.silent).toBe(false);
		expect(v.ageMinutes).toBe(10);
	});

	it('is SILENT when activity is older than the window', () => {
		const v = evaluateTripwire({ configured: true, lastActivityMs: NOW - 90 * 60_000, windowMs: WINDOW, now: NOW });
		expect(v.silent).toBe(true);
		expect(v.ageMinutes).toBe(90);
	});

	it('fires exactly at the window boundary', () => {
		expect(evaluateTripwire({ configured: true, lastActivityMs: NOW - WINDOW, windowMs: WINDOW, now: NOW }).silent).toBe(true);
	});

	it('clamps a future timestamp to age 0 (not silent)', () => {
		const v = evaluateTripwire({ configured: true, lastActivityMs: NOW + 5000, windowMs: WINDOW, now: NOW });
		expect(v).toEqual({ silent: false, ageMinutes: 0 });
	});
});

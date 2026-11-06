// Unit tests for the Ambient World DJ deterministic clock (Brief 22).
//
// The whole point of worldClock is that every viewer of the same agent sees the
// same sky: it must be a pure, deterministic function of wall time, cycle length
// and a per-agent offset — no Math.random, no hidden state. These tests pin the
// phase mapping (the day-fraction convention day-night.js consumes) and the
// time-of-day band labels the readout + DJ key off.

import { describe, it, expect } from 'vitest';
import {
	worldClock, phaseLabel, isGoldenHour, daylightAmount, DEFAULT_CYCLE_MS,
} from '../src/shared/world-clock.js';

describe('worldClock', () => {
	const CYCLE = 8 * 60 * 1000;

	it('maps the start of a cycle to midnight (phase 0)', () => {
		expect(worldClock(0, CYCLE)).toBe(0);
		expect(worldClock(CYCLE, CYCLE)).toBe(0); // exactly one cycle later wraps to 0
	});

	it('maps quarter / half / three-quarter cycle to sunrise / noon / sunset', () => {
		expect(worldClock(CYCLE * 0.25, CYCLE)).toBeCloseTo(0.25, 10);
		expect(worldClock(CYCLE * 0.5, CYCLE)).toBeCloseTo(0.5, 10);
		expect(worldClock(CYCLE * 0.75, CYCLE)).toBeCloseTo(0.75, 10);
	});

	it('is deterministic — same inputs always give the same phase', () => {
		const a = worldClock(1_700_000_123_456, CYCLE);
		const b = worldClock(1_700_000_123_456, CYCLE);
		expect(a).toBe(b);
	});

	it('always returns a phase in [0, 1)', () => {
		for (let t = -CYCLE * 3; t <= CYCLE * 3; t += CYCLE / 37) {
			const p = worldClock(t, CYCLE);
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThan(1);
		}
	});

	it('handles negative wall-clock values without going out of range', () => {
		expect(worldClock(-CYCLE * 0.25, CYCLE)).toBeCloseTo(0.75, 10);
	});

	it('applies a per-agent offset deterministically', () => {
		const offset = CYCLE * 0.5;
		expect(worldClock(0, CYCLE, offset)).toBeCloseTo(0.5, 10);
		// Two agents with different offsets diverge but each stays pure.
		expect(worldClock(0, CYCLE, CYCLE * 0.1)).not.toBe(worldClock(0, CYCLE, CYCLE * 0.6));
	});

	it('guards a non-positive cycle by falling back to the default', () => {
		expect(worldClock(DEFAULT_CYCLE_MS * 0.5, 0)).toBeCloseTo(0.5, 10);
		expect(worldClock(DEFAULT_CYCLE_MS * 0.5, -5)).toBeCloseTo(0.5, 10);
	});
});

describe('phaseLabel', () => {
	it('names the four times of day by band', () => {
		expect(phaseLabel(0.0)).toBe('night');
		expect(phaseLabel(0.25)).toBe('sunrise');
		expect(phaseLabel(0.5)).toBe('day');
		expect(phaseLabel(0.75)).toBe('dusk');
		expect(phaseLabel(0.9)).toBe('night');
	});

	it('wraps phases outside [0,1)', () => {
		expect(phaseLabel(1.25)).toBe('sunrise');
		expect(phaseLabel(-0.75)).toBe('sunrise');
	});
});

describe('isGoldenHour', () => {
	it('is true only just before sunset', () => {
		expect(isGoldenHour(0.7)).toBe(true);
		expect(isGoldenHour(0.5)).toBe(false);
		expect(isGoldenHour(0.9)).toBe(false);
	});
});

describe('daylightAmount', () => {
	it('peaks at noon and bottoms out at midnight', () => {
		expect(daylightAmount(0.5)).toBeCloseTo(1, 5);
		expect(daylightAmount(0.0)).toBe(0);
	});

	it('always returns a value in [0, 1]', () => {
		for (let p = 0; p < 1; p += 0.013) {
			const d = daylightAmount(p);
			expect(d).toBeGreaterThanOrEqual(0);
			expect(d).toBeLessThanOrEqual(1);
		}
	});
});

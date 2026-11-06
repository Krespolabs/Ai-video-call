// Sensor-fusion robustness for the /irl world-lock camera (src/irl/sensor-fusion.js).
//
// The contract these tests pin is the single most important AR reliability surface:
// no device-orientation reading — null, NaN, uncalibrated, or a 359°→1° compass
// wrap — may ever reach `cameraYaw`/`cameraPitch` in a form that snaps, spins,
// freezes, or vanishes the avatar. Pure math, no DOM / Three.js / sensors / clock.

import { describe, it, expect } from 'vitest';

import {
	COMPASS_STALE_MS,
	shortestAngleLerp,
	isFiniteReading,
	isCompassFresh,
	shouldUseAbsoluteYaw,
	resolveLockYaw,
	clampPitch,
	screenPitchDeg,
} from '../src/irl/sensor-fusion.js';

const DEG = Math.PI / 180;
const PITCH_MIN = -0.5;
const PITCH_MAX = 0.65;

describe('isFiniteReading', () => {
	it('accepts two finite Euler angles', () => {
		expect(isFiniteReading(120, 45)).toBe(true);
		expect(isFiniteReading(0, 0)).toBe(true);
		expect(isFiniteReading(-359.9, -90)).toBe(true);
	});

	it('rejects null / undefined (the old `?? 0` only caught these)', () => {
		expect(isFiniteReading(null, 45)).toBe(false);
		expect(isFiniteReading(120, undefined)).toBe(false);
		expect(isFiniteReading(undefined, undefined)).toBe(false);
	});

	it('rejects NaN and ±Infinity (the bug the old guard let through)', () => {
		expect(isFiniteReading(NaN, 45)).toBe(false);
		expect(isFiniteReading(120, NaN)).toBe(false);
		expect(isFiniteReading(Infinity, 45)).toBe(false);
		expect(isFiniteReading(120, -Infinity)).toBe(false);
	});
});

describe('isCompassFresh', () => {
	it('is fresh inside the staleness window', () => {
		const now = 10_000;
		expect(isCompassFresh(now - 100, now)).toBe(true);
		expect(isCompassFresh(now - COMPASS_STALE_MS + 1, now)).toBe(true);
	});

	it('goes stale past the window (a dead magnetometer keeps its last heading)', () => {
		const now = 10_000;
		expect(isCompassFresh(now - COMPASS_STALE_MS - 1, now)).toBe(false);
		expect(isCompassFresh(now - 60_000, now)).toBe(false);
	});

	it('is never fresh before the first sample (lastGoodAt = 0 / non-finite)', () => {
		// The sentinel is 0; with a real monotonic clock `now` is far larger, so the
		// gap exceeds the window and the absolute path is correctly skipped at boot.
		expect(isCompassFresh(0, 50_000)).toBe(false);
		expect(isCompassFresh(NaN, 50_000)).toBe(false);
	});

	it('honors a custom staleness budget', () => {
		expect(isCompassFresh(900, 1000, 50)).toBe(false);
		expect(isCompassFresh(960, 1000, 50)).toBe(true);
	});
});

describe('shouldUseAbsoluteYaw', () => {
	it('requires GPS anchor AND a fresh, present compass', () => {
		expect(shouldUseAbsoluteYaw({ gpsModeActive: true, compassHeading: 90, compassFresh: true })).toBe(true);
	});

	it('stays relative without a GPS world-anchor (avatar would jump off-frame)', () => {
		expect(shouldUseAbsoluteYaw({ gpsModeActive: false, compassHeading: 90, compassFresh: true })).toBe(false);
	});

	it('stays relative with no compass or a stale one', () => {
		expect(shouldUseAbsoluteYaw({ gpsModeActive: true, compassHeading: null, compassFresh: true })).toBe(false);
		expect(shouldUseAbsoluteYaw({ gpsModeActive: true, compassHeading: undefined, compassFresh: true })).toBe(false);
		expect(shouldUseAbsoluteYaw({ gpsModeActive: true, compassHeading: 90, compassFresh: false })).toBe(false);
	});

	it('treats heading 0 (due north) as a real bearing, not absent', () => {
		expect(shouldUseAbsoluteYaw({ gpsModeActive: true, compassHeading: 0, compassFresh: true })).toBe(true);
	});
});

describe('shortestAngleLerp', () => {
	it('moves along the shortest arc across the π/−π seam', () => {
		// from just under +π to just over −π is a tiny step, not a ~2π sweep.
		const from = Math.PI - 0.05;
		const to = -Math.PI + 0.05;
		const out = shortestAngleLerp(from, to, 0.5);
		expect(Math.abs(out - from)).toBeLessThan(0.06);
	});

	it('eases a fraction of the way at t<1 and lands exactly at t=1', () => {
		expect(shortestAngleLerp(0, 1, 0)).toBeCloseTo(0, 10);
		expect(shortestAngleLerp(0, 1, 1)).toBeCloseTo(1, 10);
		expect(shortestAngleLerp(0, 1, 0.5)).toBeCloseTo(0.5, 10);
	});
});

describe('resolveLockYaw — relative path', () => {
	const base = { useAbsolute: false, prevYaw: 0, baseAlpha: 10, baseYaw: 0, compassHeading: null };

	it('integrates alpha deltas from the lock baseline', () => {
		const out = resolveLockYaw({ ...base, alpha: 40 }); // +30° from baseline
		expect(out).toBeCloseTo(30 * DEG, 9);
	});

	it('wraps the alpha delta across the 0/360 boundary (no 340° jump)', () => {
		// baseline 10°, reading 350° is a 20° turn the OTHER way, not +340°.
		const out = resolveLockYaw({ ...base, alpha: 350 });
		expect(out).toBeCloseTo(-20 * DEG, 9);
	});

	it('is finite for every in-range input', () => {
		for (let alpha = 0; alpha < 360; alpha += 23) {
			expect(Number.isFinite(resolveLockYaw({ ...base, alpha }))).toBe(true);
		}
	});
});

describe('resolveLockYaw — absolute path (the 359°→1° spin guard)', () => {
	const compassToYaw = (deg) => -deg * DEG;

	it('crossing 359°→1° is a small step, never a ~360° spin', () => {
		const prevYaw = compassToYaw(359);
		const out = resolveLockYaw({
			useAbsolute: true, prevYaw, alpha: 0, baseAlpha: 0, baseYaw: 0,
			compassHeading: 1, absoluteSmooth: 0.4,
		});
		// The real heading moved 2°; the yaw step must be a fraction of that, not 2π.
		expect(Math.abs(out - prevYaw)).toBeLessThan(0.1);
		expect(Math.abs(out - prevYaw)).toBeGreaterThan(0);
	});

	it('converges onto the target bearing (mod 2π) over repeated frames', () => {
		let yaw = compassToYaw(350);
		for (let i = 0; i < 40; i++) {
			yaw = resolveLockYaw({
				useAbsolute: true, prevYaw: yaw, alpha: 0, baseAlpha: 0, baseYaw: 0,
				compassHeading: 5, absoluteSmooth: 0.4,
			});
		}
		// Compare orientations modulo 2π: sin/cos must match the target bearing.
		const target = compassToYaw(5);
		expect(Math.sin(yaw)).toBeCloseTo(Math.sin(target), 4);
		expect(Math.cos(yaw)).toBeCloseTo(Math.cos(target), 4);
	});

	it('a hard assignment (smooth=1) lands exactly on the bearing', () => {
		const out = resolveLockYaw({
			useAbsolute: true, prevYaw: 1.23, alpha: 0, baseAlpha: 0, baseYaw: 0,
			compassHeading: 90, absoluteSmooth: 1,
		});
		expect(out).toBeCloseTo(compassToYaw(90), 9);
	});
});

describe('clampPitch', () => {
	it('clamps into [min, max]', () => {
		expect(clampPitch(2, PITCH_MIN, PITCH_MAX)).toBe(PITCH_MAX);
		expect(clampPitch(-2, PITCH_MIN, PITCH_MAX)).toBe(PITCH_MIN);
		expect(clampPitch(0.3, PITCH_MIN, PITCH_MAX)).toBe(0.3);
	});

	it('collapses a non-finite pitch to a safe in-range 0 (never NaN)', () => {
		expect(clampPitch(NaN, PITCH_MIN, PITCH_MAX)).toBe(0);
		expect(clampPitch(Infinity, PITCH_MIN, PITCH_MAX)).toBe(0);
		expect(Number.isFinite(clampPitch(NaN, PITCH_MIN, PITCH_MAX))).toBe(true);
	});
});

// The screen-orientation frame correction (task-02): the gyro pitch path assumes
// the phone is held portrait. screenPitchDeg() folds screen.orientation.angle back
// into a portrait-equivalent pitch so the world-lock holds through rotation.
describe('screenPitchDeg', () => {
	it('portrait (angle 0) passes beta through, ignoring gamma', () => {
		expect(screenPitchDeg(30, 12, 0)).toBe(30);
		expect(screenPitchDeg(-45, 80, 0)).toBe(-45);
	});

	it('landscape ⟲90° reads pitch from +gamma instead of beta', () => {
		expect(screenPitchDeg(0, 30, 90)).toBe(30);
		expect(screenPitchDeg(88, -20, 90)).toBe(-20);
	});

	it('upside-down portrait (180°) inverts beta', () => {
		expect(screenPitchDeg(30, 0, 180)).toBe(-30);
		expect(screenPitchDeg(-45, 0, 180)).toBe(45);
	});

	it('landscape ⟳270° reads pitch from −gamma (the opposite landscape sign)', () => {
		expect(screenPitchDeg(0, 30, 270)).toBe(-30);
		expect(screenPitchDeg(0, -25, 270)).toBe(25);
	});

	it('defaults to portrait when the angle is omitted', () => {
		expect(screenPitchDeg(42, 99)).toBe(42);
	});

	it('snaps an off-grid / rounding-noisy angle to the nearest 90° bucket', () => {
		expect(screenPitchDeg(0, 30, 88)).toBe(30);   // → 90
		expect(screenPitchDeg(30, 0, 179)).toBe(-30); // → 180
		expect(screenPitchDeg(0, 30, 271)).toBe(-30); // → 270
	});

	it('normalizes negative / >360 angles into the canonical bucket', () => {
		expect(screenPitchDeg(30, 0, -180)).toBe(-30); // -180 → 180
		expect(screenPitchDeg(0, 30, 450)).toBe(30);   // 450 → 90
	});

	it('collapses a non-finite active axis to the horizon (0), never NaN', () => {
		expect(screenPitchDeg(NaN, 30, 0)).toBe(0);     // portrait reads beta
		expect(screenPitchDeg(30, NaN, 90)).toBe(0);    // landscape reads gamma
		expect(Number.isFinite(screenPitchDeg(NaN, NaN, 270))).toBe(true);
	});

	it('ignores the inactive axis being non-finite', () => {
		expect(screenPitchDeg(30, NaN, 0)).toBe(30);    // portrait: gamma unused
		expect(screenPitchDeg(NaN, 30, 90)).toBe(30);   // landscape: beta unused
	});
});

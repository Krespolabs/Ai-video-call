// Camera-FOV optics for the /irl AR passthrough (src/irl/camera-fov.js).
//
// In AR the Three.js camera must share the real rear camera's field of view or the
// avatar renders at the wrong scale. The FOV is derived once from the video track's
// sensor aspect, but the VERTICAL FOV that Three.js wants depends on the VIEWPORT
// aspect — which flips on rotate. These tests pin that the derivation tracks the
// viewport (so portrait↔landscape holds the avatar's real-world scale) and that
// every degenerate input is defended into a sane, clamped, finite angle — the
// function is called straight from a resize handler, so it must never return NaN/∞.

import { describe, it, expect } from 'vitest';

import {
	deriveVerticalFovDeg,
	DEFAULT_DIAG_FOV_DEG,
	VFOV_MIN_DEG,
	VFOV_MAX_DEG,
} from '../src/irl/camera-fov.js';

// Independent re-derivation of the same optics, used as an oracle so the tests
// assert the actual geometry rather than echoing the implementation's constants.
function expectedVFov({ tw, th, vw, vh, diag = DEFAULT_DIAG_FOV_DEG }) {
	const DEG = Math.PI / 180, RAD = 180 / Math.PI;
	const diagPx = Math.hypot(tw, th);
	const hFov = 2 * Math.atan((tw / diagPx) * Math.tan((diag * DEG) / 2));
	const vFov = 2 * Math.atan(Math.tan(hFov / 2) / (vw / vh)) * RAD;
	return Math.max(VFOV_MIN_DEG, Math.min(VFOV_MAX_DEG, vFov));
}

describe('deriveVerticalFovDeg — optics', () => {
	it('matches the closed-form geometry for a 1280×720 sensor in portrait', () => {
		const out = deriveVerticalFovDeg({ trackWidth: 1280, trackHeight: 720, viewWidth: 390, viewHeight: 844 });
		expect(out).toBeCloseTo(expectedVFov({ tw: 1280, th: 720, vw: 390, vh: 844 }), 6);
	});

	it('a tall portrait viewport yields a wider vertical FOV than a wide landscape one', () => {
		// Same sensor, viewport rotated 90°. Portrait fills more vertical angle.
		const portrait  = deriveVerticalFovDeg({ trackWidth: 1280, trackHeight: 720, viewWidth: 390, viewHeight: 844 });
		const landscape = deriveVerticalFovDeg({ trackWidth: 1280, trackHeight: 720, viewWidth: 844, viewHeight: 390 });
		expect(portrait).toBeGreaterThan(landscape);
	});

	it('the vertical FOV tracks the viewport aspect, not the (fixed) sensor aspect', () => {
		// Rotating the device does not change the sensor dims, only the viewport.
		// If the derivation wrongly used the sensor aspect both calls would match.
		const a = deriveVerticalFovDeg({ trackWidth: 1920, trackHeight: 1080, viewWidth: 400, viewHeight: 900 });
		const b = deriveVerticalFovDeg({ trackWidth: 1920, trackHeight: 1080, viewWidth: 900, viewHeight: 400 });
		expect(Math.abs(a - b)).toBeGreaterThan(1);
	});
});

describe('deriveVerticalFovDeg — clamping & defense', () => {
	it('clamps the result into [VFOV_MIN, VFOV_MAX]', () => {
		// An extreme viewport aspect would push the raw FOV outside the safe band.
		const wide = deriveVerticalFovDeg({ trackWidth: 1280, trackHeight: 720, viewWidth: 4000, viewHeight: 200 });
		const tall = deriveVerticalFovDeg({ trackWidth: 1280, trackHeight: 720, viewWidth: 200, viewHeight: 4000 });
		expect(wide).toBeGreaterThanOrEqual(VFOV_MIN_DEG);
		expect(tall).toBeLessThanOrEqual(VFOV_MAX_DEG);
	});

	it('never returns NaN/∞ for degenerate (zero / negative) track dimensions', () => {
		for (const dims of [
			{ trackWidth: 0, trackHeight: 0, viewWidth: 390, viewHeight: 844 },
			{ trackWidth: -1280, trackHeight: 720, viewWidth: 390, viewHeight: 844 },
			{ trackWidth: 1, trackHeight: 1, viewWidth: 390, viewHeight: 844 },
		]) {
			const out = deriveVerticalFovDeg(dims);
			expect(Number.isFinite(out)).toBe(true);
			expect(out).toBeGreaterThanOrEqual(VFOV_MIN_DEG);
			expect(out).toBeLessThanOrEqual(VFOV_MAX_DEG);
		}
	});

	it('falls back to sensible values when the viewport dims are non-finite', () => {
		const out = deriveVerticalFovDeg({ trackWidth: 1280, trackHeight: 720, viewWidth: NaN, viewHeight: undefined });
		expect(Number.isFinite(out)).toBe(true);
		expect(out).toBeGreaterThanOrEqual(VFOV_MIN_DEG);
		expect(out).toBeLessThanOrEqual(VFOV_MAX_DEG);
	});

	it('uses the default diagonal FOV when an invalid one is supplied', () => {
		const bad  = deriveVerticalFovDeg({ trackWidth: 1280, trackHeight: 720, viewWidth: 390, viewHeight: 844, diagFovDeg: 0 });
		const good = deriveVerticalFovDeg({ trackWidth: 1280, trackHeight: 720, viewWidth: 390, viewHeight: 844 });
		expect(bad).toBeCloseTo(good, 6);
	});
});

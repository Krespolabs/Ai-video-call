// Monocular marker pose optics (src/irl/marker-pose.js).
//
// These pin the pinhole math that turns a QR's on-screen geometry into a metric
// camera-space pose: get the focal length, distance, or principal-point handling
// wrong and every marker-anchored agent lands at the wrong depth for everyone. No
// camera, no Three.js — the world transform is the caller's job.

import { describe, it, expect } from 'vitest';

import {
	focalLengthPx,
	estimateDistanceM,
	cameraSpacePoint,
	markerPoseCamera,
	DEFAULT_MARKER_SIZE_M,
} from '../src/irl/marker-pose.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('focalLengthPx', () => {
	it('a 90° vertical FOV gives f = H/2 (tan45 = 1)', () => {
		expect(near(focalLengthPx(90, 480), 240)).toBe(true);
	});

	it('a narrower FOV gives a longer focal length', () => {
		expect(focalLengthPx(60, 480)).toBeGreaterThan(focalLengthPx(90, 480));
	});

	it('defends degenerate input', () => {
		expect(focalLengthPx(0, 480)).toBe(0);
		expect(focalLengthPx(60, 0)).toBe(0);
		expect(focalLengthPx(NaN, 480)).toBe(0);
	});
});

describe('estimateDistanceM', () => {
	it('Z = f·S/span — a marker imaged at f px across sits one focal length away', () => {
		// span == f px → distance == physical size.
		expect(near(estimateDistanceM(240, 0.16, 240), 0.16)).toBe(true);
	});

	it('halving the on-screen span doubles the distance', () => {
		const near100 = estimateDistanceM(200, 0.16, 240);
		const far50 = estimateDistanceM(100, 0.16, 240);
		expect(near(far50, near100 * 2)).toBe(true);
	});

	it('defends degenerate input', () => {
		expect(estimateDistanceM(0, 0.16, 240)).toBe(0);
		expect(estimateDistanceM(100, 0, 240)).toBe(0);
		expect(estimateDistanceM(100, 0.16, 0)).toBe(0);
	});
});

describe('cameraSpacePoint', () => {
	const frame = { w: 640, h: 480 };
	const fpx = 240;

	it('the principal point projects straight ahead (−Z), no lateral offset', () => {
		const p = cameraSpacePoint(320, 240, frame, fpx, 2);
		expect(near(p.x, 0)).toBe(true);
		expect(near(p.y, 0)).toBe(true);
		expect(near(p.z, -2)).toBe(true); // forward is −Z
	});

	it('a pixel right of centre maps to +X; below centre maps to −Y (image y flips)', () => {
		const right = cameraSpacePoint(320 + 240, 240, frame, fpx, 2); // one focal length right
		expect(near(right.x, 2)).toBe(true); // (240/240)*2
		const below = cameraSpacePoint(320, 240 + 240, frame, fpx, 2);
		expect(near(below.y, -2)).toBe(true);
	});
});

describe('markerPoseCamera', () => {
	const frame = { w: 640, h: 480 };
	// A centred 96px marker, right edge 48px to the right of centre.
	const base = {
		center: { x: 320, y: 240 },
		rightMid: { x: 368, y: 240 },
		spanPx: 96,
		frame,
		vfovDeg: 90, // f = 240px
	};

	it('places a centred marker straight ahead at the metric distance', () => {
		const pose = markerPoseCamera(base);
		expect(pose.ok).toBe(true);
		// f=240, span=96, S=0.16 → Z = 240*0.16/96 = 0.4 m.
		expect(near(pose.distanceM, 0.4)).toBe(true);
		expect(near(pose.center.x, 0)).toBe(true);
		expect(near(pose.center.z, -0.4)).toBe(true);
		// Right point is offset +X, same depth → its facing delta is purely lateral.
		expect(pose.right.x).toBeGreaterThan(pose.center.x);
		expect(near(pose.right.z, pose.center.z)).toBe(true);
	});

	it('flags an implausible (too far) read as not ok', () => {
		const pose = markerPoseCamera({ ...base, spanPx: 1 }); // ~38 m away
		expect(pose.ok).toBe(false);
	});

	it('defaults the marker size when unspecified', () => {
		const pose = markerPoseCamera(base);
		const explicit = markerPoseCamera({ ...base, markerSizeM: DEFAULT_MARKER_SIZE_M });
		expect(near(pose.distanceM, explicit.distanceM)).toBe(true);
	});
});

// QR detection pure helpers (src/irl/qr-detect.js).
//
// The scan LOOP and BarcodeDetector itself need a camera and a browser API, so
// they're exercised on-device. What's unit-tested here is the pure geometry the
// loop hands to the frame math — corner centroid, right-edge midpoint, on-screen
// span, screen→NDC, and the best-marker selection gate — because a sign error or
// a wrong corner index there silently anchors every agent at the wrong spot.

import { describe, it, expect } from 'vitest';

import {
	cornerCenter,
	cornerRightMid,
	cornerSpanPx,
	screenToNdc,
	pickBestMarker,
	barcodeDetectorSupported,
} from '../src/irl/qr-detect.js';

// A 100px QR with top-left at (200,100): TL,TR,BR,BL clockwise.
const SQUARE = [
	{ x: 200, y: 100 }, // top-left
	{ x: 300, y: 100 }, // top-right
	{ x: 300, y: 200 }, // bottom-right
	{ x: 200, y: 200 }, // bottom-left
];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('corner geometry', () => {
	it('centre is the centroid of the four corners', () => {
		expect(cornerCenter(SQUARE)).toEqual({ x: 250, y: 150 });
	});

	it('right-edge midpoint is between top-right and bottom-right', () => {
		expect(cornerRightMid(SQUARE)).toEqual({ x: 300, y: 150 });
	});

	it('span is the mean edge length (100px for a 100px square)', () => {
		expect(near(cornerSpanPx(SQUARE), 100)).toBe(true);
	});
});

describe('screenToNdc', () => {
	it('maps frame centre to (0,0) and flips Y', () => {
		const centre = screenToNdc(320, 240, 640, 480);
		expect(near(centre.x, 0)).toBe(true);
		expect(near(centre.y, 0)).toBe(true); // −0 is fine; compare numerically, not structurally
		// Top-left pixel → NDC (−1, +1); bottom-right → (+1, −1).
		expect(screenToNdc(0, 0, 640, 480)).toEqual({ x: -1, y: 1 });
		expect(screenToNdc(640, 480, 640, 480)).toEqual({ x: 1, y: -1 });
	});
});

describe('pickBestMarker', () => {
	const frame = { w: 640, h: 480 };

	it('returns null with no detections', () => {
		expect(pickBestMarker([], { frame })).toBeNull();
		expect(pickBestMarker(null, { frame })).toBeNull();
	});

	it('rejects markers below the minimum on-screen span (too far)', () => {
		const tiny = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }]; // 20px span
		expect(pickBestMarker([{ cornerPoints: tiny }], { minSpanPx: 44, frame })).toBeNull();
	});

	it('skips malformed corner sets (wrong count / non-finite) without throwing', () => {
		const bad = [
			{ cornerPoints: [{ x: 0, y: 0 }] }, // too few
			{ cornerPoints: [{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
		];
		expect(pickBestMarker(bad, { frame })).toBeNull();
	});

	it('picks the largest marker and carries its decoded value + span', () => {
		const small = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }]; // span 60
		const big = SQUARE; // span 100, near centre
		const picked = pickBestMarker(
			[{ cornerPoints: small, rawValue: 'far' }, { cornerPoints: big, rawValue: 'near' }],
			{ frame },
		);
		expect(picked?.rawValue).toBe('near');
		expect(near(picked.spanPx, 100)).toBe(true);
		// The selection score is internal — it must not leak into the returned shape.
		expect(picked).not.toHaveProperty('score');
	});

	it('uses the centre offset only as a mild tie-break between similar sizes', () => {
		// Two equal-size markers: the one nearer the frame centre wins.
		const mk = (cx, cy) => [
			{ x: cx - 50, y: cy - 50 }, { x: cx + 50, y: cy - 50 },
			{ x: cx + 50, y: cy + 50 }, { x: cx - 50, y: cy + 50 },
		];
		const picked = pickBestMarker(
			[{ cornerPoints: mk(320, 240), rawValue: 'centre' }, { cornerPoints: mk(120, 120), rawValue: 'corner' }],
			{ frame },
		);
		expect(picked?.rawValue).toBe('centre');
	});
});

describe('capability probe', () => {
	it('reports BarcodeDetector absence without throwing (jsdom has none)', () => {
		expect(typeof barcodeDetectorSupported()).toBe('boolean');
	});
});

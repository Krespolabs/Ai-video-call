// Pure floor-anchor math (src/irl/floor-anchor.js).
//
// The contract these tests pin is the WebXR write path: when you tap to place an
// agent on the floor, the anchored local pose must convert to a GPS pin that
// reloads where you tapped — for you and for every other viewer. A sign error
// here (the classic: storing +z as north instead of −z) ships silently and lands
// every saved anchor on the wrong side of the room. So we assert the projection
// round-trips through room-anchor's geoToLocal, the yaw extraction is right at
// every cardinal, and height/source ride through untouched. Pure math, no DOM /
// Three.js / clock — mirrors tests/irl-room-anchor.test.js.

import { describe, it, expect } from 'vitest';

import { yawDegFromQuat, anchorPoseToPin, roomRelFromGeo, roomPlacementFromHit } from '../src/irl/floor-anchor.js';
import { geoToLocal, agentWorldPosition, roomOriginWorld } from '../src/irl/room-anchor.js';

const ORIGIN = { lat: 37.7749, lng: -122.4194 }; // arbitrary; math is origin-relative
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// A yaw about world-Y by `deg` degrees, encoded as a quaternion [x,y,z,w].
// yawDegFromQuat reads the same clockwise-from-−Z convention savePin stores, so a
// quaternion built as a +Y rotation of θ must read back as θ.
const yawQuat = (deg) => {
	const half = (deg * Math.PI) / 180 / 2;
	return [0, Math.sin(half), 0, Math.cos(half)];
};

describe('yawDegFromQuat', () => {
	it('the identity quaternion is 0° yaw', () => {
		expect(yawDegFromQuat(0, 0, 0, 1)).toBe(0);
	});

	it('cardinal yaw quaternions read back as 90 / 180 / 270', () => {
		expect(near(yawDegFromQuat(...yawQuat(90)), 90)).toBe(true);
		expect(near(Math.abs(yawDegFromQuat(...yawQuat(180))), 180)).toBe(true); // ±180 are the same heading
		// 270° comes back as −90° in the raw atan2 range; the persist path normalises it.
		expect(near(yawDegFromQuat(...yawQuat(270)), -90)).toBe(true);
	});

	it('a wider sweep round-trips through anchorPoseToPin into [0,360)', () => {
		for (const deg of [0, 45, 90, 135, 180, 225, 270, 315, 359]) {
			const { heading } = anchorPoseToPin({
				originLat: ORIGIN.lat, originLng: ORIGIN.lng,
				x: 0, y: 0, z: 0, quat: yawQuat(deg),
			});
			expect(heading).toBeGreaterThanOrEqual(0);
			expect(heading).toBeLessThan(360);
			expect(near(heading, deg, 1)).toBe(true); // rounded to whole degrees
		}
	});
});

describe('anchorPoseToPin', () => {
	const QUAT = yawQuat(0);

	it('a pose +2 m east / +3 m north of the origin round-trips back to (2, 3)', () => {
		// Local frame: +X = east, world north = −Z, so 3 m north is z = −3.
		const pin = anchorPoseToPin({
			originLat: ORIGIN.lat, originLng: ORIGIN.lng,
			x: 2, y: 0, z: -3, quat: QUAT,
		});
		const back = geoToLocal(ORIGIN.lat, ORIGIN.lng, pin.lat, pin.lng);
		expect(near(back.east, 2, 1e-3)).toBe(true);
		expect(near(back.north, 3, 1e-3)).toBe(true);
	});

	it('the sign of z is north-negated (catches the +z mistake)', () => {
		// Walking the agent to +z (south) must DECREASE latitude, not increase it.
		const south = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 0, y: 0, z: 5, quat: QUAT });
		const north = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 0, y: 0, z: -5, quat: QUAT });
		expect(south.lat).toBeLessThan(ORIGIN.lat);
		expect(north.lat).toBeGreaterThan(ORIGIN.lat);
		// +x is east → longitude increases.
		const east = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 5, y: 0, z: 0, quat: QUAT });
		expect(east.lng).toBeGreaterThan(ORIGIN.lng);
	});

	it('heightM passes through unchanged (negative = below eye level)', () => {
		const below = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 0, y: -1.4, z: 0, quat: QUAT });
		expect(below.heightM).toBe(-1.4);
		const above = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 0, y: 0.6, z: 0, quat: QUAT });
		expect(above.heightM).toBe(0.6);
	});

	it('quat passes through untouched and source is webxr', () => {
		const q = yawQuat(47);
		const pin = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 1, y: 0, z: 1, quat: q });
		expect(pin.quat).toBe(q);
		expect(pin.source).toBe('webxr');
	});
});

// ── Render-back yaw precision (irl-floor-anchor task 02) ─────────────────────
// The viewer derives facing from the stored anchor_quat (full float) rather than
// the rounded anchor_yaw_deg, so a non-axis placement reloads at the EXACT tap
// angle for every viewer. These tests pin that the float survives the persist →
// render-back round-trip — the justification for keeping anchor_quat a live column
// instead of a dead field. pinYawRad in src/irl.js applies this same
// yawDegFromQuat(...pin.anchor_quat) on the read path.
describe('anchor_quat precision survives the persist → render-back round-trip', () => {
	// What the renderer does with a stored pin: read yaw straight off anchor_quat,
	// normalised to [0,360) exactly as pinYawRad / spawnNearbyPin reads it back.
	const renderBackYaw = (quat) => (((yawDegFromQuat(...quat) % 360) + 360) % 360);

	it('a fractional, non-axis yaw (137.4°) reloads within <0.5°', () => {
		const TAP = 137.4; // deliberately off every cardinal AND not a whole degree
		const pin = anchorPoseToPin({
			originLat: ORIGIN.lat, originLng: ORIGIN.lng,
			x: 0, y: 0, z: 0, quat: yawQuat(TAP),
		});
		// The render-back source (anchor_quat) keeps the fractional angle…
		expect(Math.abs(renderBackYaw(pin.quat) - TAP)).toBeLessThan(0.5);
		// …while the rounded heading column has already discarded the .4° tail. This
		// gap is the whole reason render-back prefers the quat.
		expect(pin.heading).toBe(137);
		expect(Math.abs(pin.heading - TAP)).toBeGreaterThan(0.3);
	});

	it('a fine sweep of off-axis tap angles each reload within <0.5°', () => {
		for (const TAP of [12.7, 47.6, 99.1, 137.4, 211.95, 268.3, 314.85, 359.6]) {
			const pin = anchorPoseToPin({
				originLat: ORIGIN.lat, originLng: ORIGIN.lng,
				x: 0, y: 0, z: 0, quat: yawQuat(TAP),
			});
			const back = renderBackYaw(pin.quat);
			// Compare on the circle so 359.6° vs 0.x° wraps cleanly.
			const delta = Math.min(Math.abs(back - TAP), 360 - Math.abs(back - TAP));
			expect(delta).toBeLessThan(0.5);
		}
	});

	it('the quat-derived yaw beats the integer column for a sub-degree placement', () => {
		// Two taps that the integer anchor_yaw_deg cannot tell apart (both round to
		// 90°) stay distinct through the quat — proving the column carries real signal.
		const a = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 0, y: 0, z: 0, quat: yawQuat(90.3) });
		const b = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 0, y: 0, z: 0, quat: yawQuat(89.7) });
		expect(a.heading).toBe(b.heading); // 90 === 90 — the rounded column collapses them
		expect(renderBackYaw(a.quat)).not.toBe(renderBackYaw(b.quat)); // the quat does not
		expect(renderBackYaw(a.quat) - renderBackYaw(b.quat)).toBeCloseTo(0.6, 5);
	});
});

// ── WebXR → room frame (R3) ──────────────────────────────────────────────────
// A floor hit must land in the SHARED room frame, not a standalone GPS pin, so a
// WebXR-placed agent renders identically for every viewer. These pin the two new
// write-path conversions: roomRelFromGeo (lat/lng → exact room offset, used by the
// calibrate/refine PATCH) and roomPlacementFromHit (XR hit pose → room placement).
describe('roomRelFromGeo', () => {
	const QUAT = yawQuat(0);

	it('inverts anchorPoseToPin: a point 2 m E / 3 m N of the origin → rel (2, 3)', () => {
		const pin = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 2, y: 0, z: -3, quat: QUAT });
		const rel = roomRelFromGeo({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, lat: pin.lat, lng: pin.lng });
		expect(near(rel.relEast, 2, 1e-3)).toBe(true);
		expect(near(rel.relNorth, 3, 1e-3)).toBe(true);
	});

	it('a rotated room (originYawDeg) round-trips back through agentWorldPosition', () => {
		// Store an offset in a 30°-rotated room, then render it from the origin: the
		// world position must match the un-rotated true-north offset the point implies.
		const originYawDeg = 30;
		const trueEast = 4, trueNorth = -1; // arbitrary true-north metres from origin
		const { lat, lng } = anchorPoseToPin({
			originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: trueEast, y: 0, z: trueNorth, quat: QUAT,
		}); // note z passed as north here is +trueNorth → world north is −z, see below
		const rel = roomRelFromGeo({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, originYawDeg, lat, lng });
		// Re-render from the origin (viewer ON the origin → originWorld = {0,0}).
		const world = agentWorldPosition({ originWorld: { x: 0, z: 0 }, relEast: rel.relEast, relNorth: rel.relNorth, originYawDeg });
		// anchorPoseToPin treated z as the SOUTH axis (north = −z), so the stored point
		// is trueEast east and −trueNorth north; agentWorldPosition must reproduce that.
		expect(near(world.x, trueEast, 1e-3)).toBe(true);
		expect(near(world.z, trueNorth, 1e-3)).toBe(true);
	});
});

describe('roomPlacementFromHit', () => {
	const QUAT = yawQuat(0);

	it('a hit placed by a viewer standing ON the origin re-renders at the same spot', () => {
		// Viewer == origin: a hit 2 m east / 3 m north (z = −3) of them must store as
		// rel (2, 3) and render back to world (2, 0, −3) for that same viewer.
		const p = roomPlacementFromHit({
			originLat: ORIGIN.lat, originLng: ORIGIN.lng,
			viewerLat: ORIGIN.lat, viewerLng: ORIGIN.lng,
			x: 2, y: -1.4, z: -3, quat: QUAT,
		});
		expect(near(p.relEast, 2, 1e-6)).toBe(true);
		expect(near(p.relNorth, 3, 1e-6)).toBe(true);
		const world = agentWorldPosition({ originWorld: { x: 0, z: 0 }, relEast: p.relEast, relNorth: p.relNorth });
		expect(near(world.x, 2, 1e-6)).toBe(true);
		expect(near(world.z, -3, 1e-6)).toBe(true);
		expect(p.heightM).toBe(-1.4); // real floor height rides through
		expect(p.source).toBe('webxr');
	});

	it('folds in the placer offset: an off-origin viewer’s hit lands where they aimed', () => {
		// The placer stands 5 m east of the origin and drops an agent 2 m north of
		// themselves. Rendered for that same placer (viewer at world 0), the agent must
		// sit at their local hit (x=0, z=−2) — proving the GPS offset is folded in.
		const viewer = geoToLocal(ORIGIN.lat, ORIGIN.lng, 0, 0); // unused; build viewer geo below
		void viewer;
		const east5 = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x: 5, y: 0, z: 0, quat: QUAT });
		const p = roomPlacementFromHit({
			originLat: ORIGIN.lat, originLng: ORIGIN.lng,
			viewerLat: east5.lat, viewerLng: east5.lng,
			x: 0, y: -1.4, z: -2, quat: QUAT,
		});
		// Stored offset is from the ORIGIN: 5 m east, 2 m north.
		expect(near(p.relEast, 5, 1e-3)).toBe(true);
		expect(near(p.relNorth, 2, 1e-3)).toBe(true);
		// Render for the placer (who is 5 m east of origin): agent lands at their hit.
		const originWorld = roomOriginWorld(east5.lat, east5.lng, ORIGIN.lat, ORIGIN.lng);
		const world = agentWorldPosition({ originWorld, relEast: p.relEast, relNorth: p.relNorth });
		expect(near(world.x, 0, 1e-3)).toBe(true);
		expect(near(world.z, -2, 1e-3)).toBe(true);
	});

	it('heading comes from the surface quat, normalised to [0,360)', () => {
		const p = roomPlacementFromHit({
			originLat: ORIGIN.lat, originLng: ORIGIN.lng,
			viewerLat: ORIGIN.lat, viewerLng: ORIGIN.lng,
			x: 0, y: 0, z: 0, quat: yawQuat(270),
		});
		expect(p.relYawDeg).toBe(270); // −90° from atan2, normalised
	});
});

describe('round-trip property: anchorPoseToPin then geoToLocal is identity', () => {
	it('survives within 1e-6 for assorted offsets', () => {
		for (const [x, z] of [[0, 0], [2, -3], [-4, 1], [12, 12], [-7.5, -2.25], [0.1, -0.1]]) {
			const pin = anchorPoseToPin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, x, y: 0, z, quat: yawQuat(0) });
			const back = geoToLocal(ORIGIN.lat, ORIGIN.lng, pin.lat, pin.lng);
			expect(near(back.east, x, 1e-6)).toBe(true);   // east = +x
			expect(near(back.north, -z, 1e-6)).toBe(true); // north = −z
		}
	});
});

// Room authoring session logic (src/irl/room-session.js).
//
// Pins the contract the R1 placement UI rides on: a room is established with the
// right origin + frame, an aim (heading + distance) becomes a valid room-aware
// POST body whose geometry agrees with room-anchor.js, and persisted rooms
// revive only when every field is sound. Pure — no DOM, no network, no clock.

import { describe, it, expect } from 'vitest';

import {
	ROOM_ID_RE,
	makeRoomId,
	establishRoom,
	clampDistance,
	roomPlacement,
	serializeRoom,
	reviveRoom,
	DIST_DEFAULT_M,
} from '../src/irl/room-session.js';
import { agentWorldPosition, roomOriginWorld } from '../src/irl/room-anchor.js';

const ORIGIN = { lat: 37.7749, lng: -122.4194 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('makeRoomId', () => {
	it('always produces an API-valid slug', () => {
		for (const [loc, rand] of [['9q8yyk', 'a1b2c3'], ['Living Room!', 'XYZ'], ['', ''], ['很长', '###']]) {
			expect(ROOM_ID_RE.test(makeRoomId(loc, rand))).toBe(true);
		}
	});
	it('is stable for the same inputs and differs by rand', () => {
		expect(makeRoomId('9q8yyk', 'aaa')).toBe(makeRoomId('9q8yyk', 'aaa'));
		expect(makeRoomId('9q8yyk', 'aaa')).not.toBe(makeRoomId('9q8yyk', 'bbb'));
	});
});

describe('establishRoom', () => {
	it('uses a true-north frame when an absolute compass is available', () => {
		const r = establishRoom({ ...ORIGIN, headingDeg: 137, hasAbsoluteCompass: true, locationKey: '9q8', rand: 'a1' });
		expect(r.originYawDeg).toBe(0);
		expect(r.absolute).toBe(true);
		expect(r.originLat).toBe(ORIGIN.lat);
		expect(ROOM_ID_RE.test(r.id)).toBe(true);
	});
	it('pins the frame to the current heading when only relative orientation exists', () => {
		const r = establishRoom({ ...ORIGIN, headingDeg: 137, hasAbsoluteCompass: false, locationKey: '9q8', rand: 'a1' });
		expect(r.originYawDeg).toBe(137);
		expect(r.absolute).toBe(false);
	});
	it('throws without a GPS fix rather than planting a room at 0,0', () => {
		expect(() => establishRoom({ lat: NaN, lng: NaN, locationKey: 'x', rand: 'y' })).toThrow();
	});
});

describe('clampDistance', () => {
	it('clamps to the slider range and defaults garbage', () => {
		expect(clampDistance(0.1)).toBe(0.5);
		expect(clampDistance(99)).toBe(8);
		expect(clampDistance(2.5)).toBe(2.5);
		expect(clampDistance('nope')).toBe(DIST_DEFAULT_M);
	});
});

describe('roomPlacement', () => {
	const room = establishRoom({ ...ORIGIN, hasAbsoluteCompass: true, locationKey: '9q8', rand: 'a1' });

	it('produces a valid POST room block whose world position matches room-anchor', () => {
		// Placer stands on the origin, aims due east (90°) at 3 m → couch to the right.
		const body = roomPlacement({ room, viewerLat: ORIGIN.lat, viewerLng: ORIGIN.lng, bearingDeg: 90, distM: 3 });
		expect(body.room.id).toBe(room.id);
		expect(near(body.room.relEast, 3, 1e-6)).toBe(true);
		expect(near(body.room.relNorth, 0, 1e-6)).toBe(true);
		// The agent faces the placer (placed pointing east → faces west).
		expect(body.heading).toBe(270);
		// Re-projecting the stored block lands it to the right (+X) on the floor.
		const originWorld = roomOriginWorld(ORIGIN.lat, ORIGIN.lng, room.originLat, room.originLng);
		const w = agentWorldPosition({ originWorld, relEast: body.room.relEast, relNorth: body.room.relNorth });
		expect(w.x).toBeGreaterThan(2.9);
		expect(near(w.z, 0, 1e-6)).toBe(true);
	});

	it('folds in the placer walking away from the origin', () => {
		// Placer has moved ~2 m north of the origin, then drops an agent 1 m east.
		const moved = { lat: ORIGIN.lat + 2 / 110540, lng: ORIGIN.lng };
		const body = roomPlacement({ room, viewerLat: moved.lat, viewerLng: moved.lng, bearingDeg: 90, distM: 1 });
		expect(near(body.room.relEast, 1, 1e-3)).toBe(true);   // 1 m east of origin
		expect(near(body.room.relNorth, 2, 1e-2)).toBe(true);  // + the 2 m they walked north
	});

	it('clamps distance and rejects an invalid room', () => {
		const body = roomPlacement({ room, viewerLat: ORIGIN.lat, viewerLng: ORIGIN.lng, bearingDeg: 0, distM: 999 });
		expect(near(body.room.relNorth, 8, 1e-6)).toBe(true);  // clamped to DIST_MAX_M
		expect(() => roomPlacement({ room: { id: 'Bad Id!' }, viewerLat: 0, viewerLng: 0, bearingDeg: 0, distM: 1 })).toThrow();
	});
});

describe('serialize / revive round-trip', () => {
	it('revives a sound room and rejects malformed ones', () => {
		const r = establishRoom({ ...ORIGIN, hasAbsoluteCompass: false, headingDeg: 42, locationKey: '9q8', rand: 'a1', now: 1000 });
		const back = reviveRoom(serializeRoom(r));
		expect(back.id).toBe(r.id);
		expect(back.originLat).toBe(ORIGIN.lat);
		expect(back.originYawDeg).toBe(42);
		expect(back.absolute).toBe(false);
		// Garbage / null-island / bad-id all reject to null.
		expect(reviveRoom('not json')).toBeNull();
		expect(reviveRoom(JSON.stringify({ id: 'ok', originLat: 0, originLng: 0 }))).toBeNull();
		expect(reviveRoom(JSON.stringify({ id: 'Bad Id', originLat: 1, originLng: 1 }))).toBeNull();
	});
});

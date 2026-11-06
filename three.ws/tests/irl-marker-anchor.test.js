// Marker-frame colocalization math (src/irl/marker-anchor.js).
//
// The contract these tests pin is the whole reason the marker path exists: two
// phones that never share GPS or a compass still render a placed agent in the
// SAME physical spot, purely because both observe the same QR. The headline test
// is exactly the user's scenario — one phone places an avatar relative to a marker
// on the wall; a second phone, whose AR session has a totally different (arbitrary)
// heading and origin, localizes the same marker and reconstructs the avatar at the
// identical position relative to it. Pure math, no DOM / Three.js / camera.

import { describe, it, expect } from 'vitest';

import {
	normalizeMarkerPayload,
	markerRoomId,
	isMarkerRoomId,
	MARKER_ROOM_PREFIX,
	markerYawFromEdge,
	markerRelFromWorld,
	markerWorldPos,
	markerRoomBlock,
} from '../src/irl/marker-anchor.js';
import { localToBearingDistance } from '../src/irl/room-anchor.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
// Rotate an (east, north) vector by `deg` clockwise-from-north, i.e. simulate the
// unknown heading offset between two AR sessions observing the same marker.
function rotEN(east, north, deg) {
	const r = (deg * Math.PI) / 180;
	const cos = Math.cos(r), sin = Math.sin(r);
	// Clockwise-from-north rotation matches localToTrueNorth's convention.
	return { east: east * cos + north * sin, north: -east * sin + north * cos };
}

describe('normalizeMarkerPayload', () => {
	it('trims, lower-cases, and rejects empties', () => {
		expect(normalizeMarkerPayload('  ABC123  ')).toBe('abc123');
		expect(normalizeMarkerPayload('')).toBeNull();
		expect(normalizeMarkerPayload('   ')).toBeNull();
		expect(normalizeMarkerPayload(null)).toBeNull();
		expect(normalizeMarkerPayload(42)).toBeNull();
	});

	it('collapses a three.ws marker URL and its bare token to one identity', () => {
		const fromUrl = normalizeMarkerPayload('https://three.ws/irl?m=Living-Room-7');
		const fromBare = normalizeMarkerPayload('living-room-7');
		expect(fromUrl).toBe('living-room-7');
		expect(fromUrl).toBe(fromBare);
	});

	it('decodes a percent-encoded token and ignores other query params', () => {
		expect(normalizeMarkerPayload('http://three.ws/irl?x=1&m=a%20b&z=2')).toBe('a b');
	});

	it('caps absurdly long payloads', () => {
		expect(normalizeMarkerPayload('q'.repeat(5000))).toHaveLength(512);
	});
});

describe('markerRoomId', () => {
	it('is deterministic and slug-safe (matches the API ROOM_ID_RE)', () => {
		const id = markerRoomId('https://three.ws/irl?m=kitchen');
		expect(id).toBe(markerRoomId('kitchen')); // URL and token agree
		expect(id.startsWith(MARKER_ROOM_PREFIX)).toBe(true);
		expect(id).toMatch(/^[a-z0-9-]{1,64}$/); // api/irl/pins.js ROOM_ID_RE
		expect(isMarkerRoomId(id)).toBe(true);
	});

	it('gives distinct ids to distinct markers (incl. near-anagrams)', () => {
		const ids = new Set(['a', 'b', 'ab', 'ba', 'kitchen', 'kitchet'].map(markerRoomId));
		expect(ids.size).toBe(6);
	});

	it('returns null for an unusable payload', () => {
		expect(markerRoomId('')).toBeNull();
		expect(markerRoomId(null)).toBeNull();
		expect(isMarkerRoomId('r-sf-abc')).toBe(false); // a GPS room is not a marker room
	});
});

describe('markerYawFromEdge', () => {
	it('reads the frame yaw from the right-edge direction', () => {
		const c = { x: 0, z: 0 };
		// Right edge points east (+X) → frame north == north → yaw 0.
		expect(near(markerYawFromEdge(c, { x: 1, z: 0 }), 0)).toBe(true);
		// Right edge points north (−Z) → frame is rotated −90° → 270.
		expect(near(markerYawFromEdge(c, { x: 0, z: -1 }), 270)).toBe(true);
		// Right edge points south (+Z) → 90.
		expect(near(markerYawFromEdge(c, { x: 0, z: 1 }), 90)).toBe(true);
	});

	it('returns null when the two points coincide (no edge length)', () => {
		expect(markerYawFromEdge({ x: 2, z: 2 }, { x: 2, z: 2 })).toBeNull();
	});
});

describe('marker world ↔ rel round-trip (same session)', () => {
	it('markerWorldPos inverts markerRelFromWorld exactly', () => {
		const markerWorld = { x: 1.2, z: -3.4 };
		const markerYawDeg = 37;
		const agent = { x: 2.9, z: -5.1 };
		const rel = markerRelFromWorld({ markerWorld, markerYawDeg, x: agent.x, z: agent.z });
		const back = markerWorldPos({ markerWorld, markerYawDeg, relEast: rel.relEast, relNorth: rel.relNorth, heightM: 0 });
		expect(near(back.x, agent.x, 1e-9)).toBe(true);
		expect(near(back.z, agent.z, 1e-9)).toBe(true);
		expect(back.y).toBe(0);
	});

	it('carries height through unchanged', () => {
		const rel = markerRelFromWorld({ markerWorld: { x: 0, z: 0 }, markerYawDeg: 0, x: 1, z: -1 });
		const back = markerWorldPos({ markerWorld: { x: 0, z: 0 }, markerYawDeg: 0, ...rel, heightM: -0.8 });
		expect(near(back.y, -0.8)).toBe(true);
	});
});

describe('cross-device colocalization (the headline invariant)', () => {
	// Two phones observe the SAME physical marker. Their AR sessions have unrelated
	// origins AND an arbitrary heading offset between them — exactly the indoor case
	// where GPS+compass fail. The agent must reconstruct on phone B at the same place
	// relative to the marker as phone A stored it.
	it('reconstructs the agent at the identical marker-relative pose on a differently-oriented session', () => {
		// Phone A (the placer).
		const markerA = { x: 1, z: -3 };
		const yawA = 40;
		const agentA = { x: 2.5, z: -5 };
		const rel = markerRelFromWorld({ markerWorld: markerA, markerYawDeg: yawA, x: agentA.x, z: agentA.z });

		// Phone B (the friend): same marker, different session frame. Its origin is
		// elsewhere and its heading is rotated by an unknown HEADING_OFFSET; its
		// measured marker yaw shifts by the same offset (the marker is physically fixed).
		const HEADING_OFFSET = 75;
		const markerB = { x: -2, z: 1 };
		const yawB = (yawA + HEADING_OFFSET) % 360;
		const worldB = markerWorldPos({ markerWorld: markerB, markerYawDeg: yawB, relEast: rel.relEast, relNorth: rel.relNorth, heightM: 0 });

		// Invariant 1: distance from the marker is preserved (rigid transform).
		const distA = Math.hypot(agentA.x - markerA.x, agentA.z - markerA.z);
		const distB = Math.hypot(worldB.x - markerB.x, worldB.z - markerB.z);
		expect(near(distB, distA, 1e-9)).toBe(true);

		// Invariant 2: the agent's bearing RELATIVE TO THE MARKER's facing is identical
		// in both sessions — so "to the right of the marker" stays to its right.
		const relBearing = (mk, ag, yaw) => {
			const { bearingDeg } = localToBearingDistance(ag.x - mk.x, -(ag.z - mk.z));
			return (((bearingDeg - yaw) % 360) + 360) % 360;
		};
		expect(near(relBearing(markerA, agentA, yawA), relBearing(markerB, worldB, yawB), 1e-7)).toBe(true);
	});

	it('a pure heading offset between sessions cancels (no positional drift)', () => {
		const marker = { x: 0, z: 0 };
		const agent = { x: 3, z: -1 };
		const rel = markerRelFromWorld({ markerWorld: marker, markerYawDeg: 10, x: agent.x, z: agent.z });
		// Same marker world position, session rotated 130° — agent must orbit the marker
		// by exactly 130°, staying at the same radius (it cannot wander off).
		const rotated = markerWorldPos({ markerWorld: marker, markerYawDeg: 140, relEast: rel.relEast, relNorth: rel.relNorth, heightM: 0 });
		const expected = rotEN(agent.x - marker.x, -(agent.z - marker.z), 130);
		expect(near(rotated.x, marker.x + expected.east, 1e-9)).toBe(true);
		expect(near(rotated.z, marker.z - expected.north, 1e-9)).toBe(true);
	});
});

describe('markerRoomBlock', () => {
	it('builds a server-valid room block with a north-aligned stored frame', () => {
		const block = markerRoomBlock({ roomId: 'm-abc', indexLat: 37.77, indexLng: -122.41, relEast: 1.5, relNorth: -2 });
		expect(block).toEqual({
			id: 'm-abc',
			originLat: 37.77,
			originLng: -122.41,
			originYawDeg: 0, // marker yaw is measured live per viewer, never stored
			relEast: 1.5,
			relNorth: -2,
		});
	});
});

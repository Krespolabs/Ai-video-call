// IRL presence privacy invariants (H1 — IRL-Hardening regression fence).
//
// The realtime presence channel (IrlRoom, the irl_world Colyseus room) is coarse
// BY CONSTRUCTION: a viewer's precise GPS is snapped to their own precision-6
// geocell centre plus bounded jitter and the raw fix is discarded, and the room
// never broadcasts a pin roster (pins travel ONLY over the per-viewer proximity
// read). This file locks both guarantees so a future edit that lets raw GPS
// survive — or repopulates the pins MapSchema — turns the build RED.
//
// Pure/offline: drives the real IrlRoom methods on a plain IrlState, no transport.

import { describe, it, expect, beforeEach } from 'vitest';

import { IrlRoom } from '../multiplayer/src/rooms/IrlRoom.js';
import { IrlState } from '../multiplayer/src/irl-schemas.js';
import { encodeGeohash, decodeGeohash } from '../multiplayer/src/geohash.js';

// A precise fix (sub-millimetre tail) somewhere ordinary.
const LAT = 37.77491234567;
const LNG = -122.41945678901;
const CELL = encodeGeohash(LAT, LNG, 6);

function makeRoom(cell = CELL) {
	const room = new IrlRoom();
	room.geocell = cell;
	room.state = new IrlState();
	room.state.geocell = cell;
	return room;
}
function client(sessionId) {
	return { sessionId, userData: {} };
}

describe('IrlRoom._coarseViewerPos — raw GPS never survives the server', () => {
	let room;
	beforeEach(() => { room = makeRoom(); });

	it('returns a point inside the viewer’s own geocell but NEVER equal to the input', () => {
		const cell = decodeGeohash(CELL);
		// Run many times: the jitter is random, so prove the invariant holds every draw.
		for (let i = 0; i < 200; i++) {
			const pos = room._coarseViewerPos(LAT, LNG);
			// The precise input must never be echoed back.
			expect(pos.lat).not.toBe(LAT);
			expect(pos.lng).not.toBe(LNG);
			// The coarsened point stays inside the cell it claims (centre ± half-extent).
			expect(Math.abs(pos.lat - cell.lat)).toBeLessThanOrEqual(cell.latErr);
			expect(Math.abs(pos.lng - cell.lng)).toBeLessThanOrEqual(cell.lngErr);
		}
	});

	it('the coarsened point is at least metres away from the true fix (not a rounding no-op)', () => {
		// A precision-6 cell is ~1.2 km; the centre is far from an arbitrary corner
		// fix, so the coarsened coordinate is a different place, not a trimmed float.
		const pos = room._coarseViewerPos(LAT, LNG);
		const dLatM = Math.abs(pos.lat - LAT) * 111_320;
		const dLngM = Math.abs(pos.lng - LNG) * 111_320 * Math.cos(LAT * Math.PI / 180);
		// At least one axis must differ by a real distance — the cell snap guarantees it.
		expect(dLatM + dLngM).toBeGreaterThan(1);
	});

	it('a viewer with no/invalid fix is placed at the room cell centre, never (0,0)', () => {
		const cell = decodeGeohash(CELL);
		const pos = room._coarseViewerPos(NaN, NaN);
		expect(Math.abs(pos.lat - cell.lat)).toBeLessThanOrEqual(cell.latErr);
		expect(Math.abs(pos.lng - cell.lng)).toBeLessThanOrEqual(cell.lngErr);
		// Null-island is the failure mode we explicitly forbid.
		expect(pos.lat === 0 && pos.lng === 0).toBe(false);
	});
});

describe('IrlRoom presence — only the coarse marker leaves the server', () => {
	let room;
	beforeEach(() => { room = makeRoom(); });

	it('onJoin stores the coarse position, never the raw GPS the client reported', () => {
		room.onJoin(client('s1'), { lat: LAT, lng: LNG, agent: 'agent-1' });
		const viewer = room.state.viewers.get('s1');
		expect(viewer).toBeTruthy();
		expect(viewer.lat).not.toBe(LAT);
		expect(viewer.lng).not.toBe(LNG);
		const cell = decodeGeohash(CELL);
		expect(Math.abs(viewer.lat - cell.lat)).toBeLessThanOrEqual(cell.latErr);
		expect(Math.abs(viewer.lng - cell.lng)).toBeLessThanOrEqual(cell.lngErr);
	});

	it('a default (non-ghost) viewer reveals no avatar — counted, never positioned-by-identity', () => {
		room.onJoin(client('s2'), { lat: LAT, lng: LNG, agent: 'agent-2' });
		const viewer = room.state.viewers.get('s2');
		expect(viewer.ghost).toBe(false);
		expect(viewer.avatar).toBe('');
	});
});

describe('IrlRoom — never broadcasts a pin roster', () => {
	it('the pins MapSchema stays empty after a join (pins ride the proximity read, not the socket)', () => {
		const room = makeRoom();
		room.onJoin(client('s1'), { lat: LAT, lng: LNG, agent: 'agent-1' });
		room.onJoin(client('s2'), { lat: LAT, lng: LNG, agent: 'agent-2' });
		// Presence is populated…
		expect(room.state.viewers.size).toBe(2);
		// …but the pin roster is NEVER populated by the realtime room. A non-empty
		// pins map here would mean a placement's coordinates leaked over the socket.
		expect(room.state.pins.size).toBe(0);
	});

	it('an interaction reaction carries no coordinate, token, or actor identity', () => {
		const room = makeRoom();
		const sent = [];
		room.broadcast = (event, payload) => sent.push({ event, payload });
		room._handleInteraction(client('s1'), { type: 'open', pinId: 'pin-abc' });
		expect(sent).toHaveLength(1);
		const { event, payload } = sent[0];
		expect(event).toBe('reaction');
		// Exactly the privacy-clean trio — nothing locational or identifying.
		expect(Object.keys(payload).sort()).toEqual(['pinId', 'ts', 'type']);
		expect(payload).not.toHaveProperty('lat');
		expect(payload).not.toHaveProperty('lng');
		expect(payload).not.toHaveProperty('deviceToken');
		expect(payload).not.toHaveProperty('viewer');
	});
});

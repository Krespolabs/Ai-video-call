// D2 live viewer presence — exercises the real IrlRoom presence logic (coarse
// jitter, heartbeat, set_ghost, reaper, leave) and the irl-net presence derivation
// directly, without booting a Colyseus transport. The room methods operate on a
// plain IrlState/MapSchema, so we drive them on a lightly-initialized room.

import { describe, it, expect, beforeEach } from 'vitest';

import { IrlRoom } from '../multiplayer/src/rooms/IrlRoom.js';
import { IrlState, IrlViewer } from '../multiplayer/src/irl-schemas.js';
import { encodeGeohash, decodeGeohashBounds } from '../multiplayer/src/geohash.js';

// A cell somewhere ordinary (San Francisco-ish) for coordinate assertions.
const LAT = 37.7749;
const LNG = -122.4194;
const CELL = encodeGeohash(LAT, LNG, 6);

function makeRoom(cell = CELL) {
	const room = new IrlRoom();
	room.geocell = cell;
	room.state = new IrlState();
	room.state.geocell = cell;
	return room;
}
function client(sessionId, userData = {}) {
	return { sessionId, userData };
}

describe('IrlViewer schema (D2 append-only fields)', () => {
	it('carries the new presence fields with safe defaults', () => {
		const v = new IrlViewer();
		expect(v).toMatchObject({ id: '', lat: 0, lng: 0, agentId: '', heading: 0, avatar: '', ghost: false, tsServer: 0 });
	});
});

describe('IrlRoom presence — join', () => {
	let room;
	beforeEach(() => { room = makeRoom(); });

	it('adds a counted-only viewer by default (no ghost, no avatar)', () => {
		room.onJoin(client('s1'), { lat: LAT, lng: LNG, agent: 'agent-1' });
		expect(room.state.viewers.size).toBe(1);
		const v = room.state.viewers.get('s1');
		expect(v.id).toBe('s1');
		expect(v.ghost).toBe(false);
		expect(v.avatar).toBe('');
		expect(v.agentId).toBe('agent-1');
		expect(v.tsServer).toBeGreaterThan(0);
	});

	it('NEVER stores precise GPS — snaps to the cell centre + bounded jitter, inside the cell', () => {
		room.onJoin(client('s1'), { lat: LAT, lng: LNG });
		const v = room.state.viewers.get('s1');
		// Privacy: the stored coordinate is not the precise input.
		expect(v.lat).not.toBe(LAT);
		expect(v.lng).not.toBe(LNG);
		// ...and it stays inside the precision-6 cell it claims.
		const b = decodeGeohashBounds(CELL);
		expect(v.lat).toBeGreaterThanOrEqual(b.latMin);
		expect(v.lat).toBeLessThanOrEqual(b.latMax);
		expect(v.lng).toBeGreaterThanOrEqual(b.lngMin);
		expect(v.lng).toBeLessThanOrEqual(b.lngMax);
	});

	it('snaps a neighbour-cell viewer to THEIR own cell, not the room centre', () => {
		// A point ~2 cells east still joins this room (3x3 window) but must be placed
		// in its own cell, never the room's centre cell.
		const farLng = LNG + 0.05;
		const ownCell = encodeGeohash(LAT, farLng, 6);
		expect(ownCell).not.toBe(CELL);
		room.onJoin(client('s2'), { lat: LAT, lng: farLng });
		const v = room.state.viewers.get('s2');
		const b = decodeGeohashBounds(ownCell);
		expect(v.lng).toBeGreaterThanOrEqual(b.lngMin);
		expect(v.lng).toBeLessThanOrEqual(b.lngMax);
	});

	it('stores an avatar + ghost flag ONLY when the viewer opted in', () => {
		room.onJoin(client('opt'), { lat: LAT, lng: LNG, ghost: true, avatar: 'https://cdn/x.glb' });
		const v = room.state.viewers.get('opt');
		expect(v.ghost).toBe(true);
		expect(v.avatar).toBe('https://cdn/x.glb');

		room.onJoin(client('noopt'), { lat: LAT, lng: LNG, ghost: false, avatar: 'https://cdn/y.glb' });
		expect(room.state.viewers.get('noopt').avatar).toBe('');
	});

	it('clamps heading to an integer 0–359 bearing', () => {
		room.onJoin(client('h'), { lat: LAT, lng: LNG, heading: 725.6 });
		expect(room.state.viewers.get('h').heading).toBe(6); // 725.6 → round 726 → 6
	});
});

describe('IrlRoom presence — heartbeat / set_ghost / leave', () => {
	let room;
	beforeEach(() => {
		room = makeRoom();
		room.onJoin(client('s1'), { lat: LAT, lng: LNG });
	});

	it('heartbeat refreshes tsServer and heading without moving the marker', () => {
		const v = room.state.viewers.get('s1');
		const lat0 = v.lat, lng0 = v.lng;
		v.tsServer = 1; // backdate
		room._handleHeartbeat(client('s1'), { heading: 90 });
		expect(v.heading).toBe(90);
		expect(v.tsServer).toBeGreaterThan(1);
		expect(v.lat).toBe(lat0); // position is fixed at join time
		expect(v.lng).toBe(lng0);
	});

	it('set_ghost flips the opt-in live and clears the avatar on opt-out', () => {
		room._handleSetGhost(client('s1'), { ghost: true, avatar: 'https://cdn/a.glb' });
		expect(room.state.viewers.get('s1').ghost).toBe(true);
		expect(room.state.viewers.get('s1').avatar).toBe('https://cdn/a.glb');
		room._handleSetGhost(client('s1'), { ghost: false, avatar: 'https://cdn/a.glb' });
		expect(room.state.viewers.get('s1').ghost).toBe(false);
		expect(room.state.viewers.get('s1').avatar).toBe('');
	});

	it('onLeave removes the viewer', () => {
		room.onLeave(client('s1'));
		expect(room.state.viewers.has('s1')).toBe(false);
	});

	it('a heartbeat for an unknown session is a safe no-op', () => {
		expect(() => room._handleHeartbeat(client('ghost'), { heading: 1 })).not.toThrow();
		expect(room.state.viewers.size).toBe(1);
	});
});

describe('IrlRoom presence — reaper', () => {
	it('drops only viewers whose last heartbeat is stale', () => {
		const room = makeRoom();
		room.onJoin(client('fresh'), { lat: LAT, lng: LNG });
		room.onJoin(client('stale'), { lat: LAT, lng: LNG });
		// Backdate 'stale' well past the 30 s window; 'fresh' stays current.
		room.state.viewers.get('stale').tsServer = Date.now() - 60_000;
		room._reapStaleViewers();
		expect(room.state.viewers.has('fresh')).toBe(true);
		expect(room.state.viewers.has('stale')).toBe(false);
	});
});

// Room authoring session for /irl "place agents around me" (Epic R / R1).
//
// Pure logic so the UI layer in src/irl.js stays thin and this is unit-tested
// without a phone (mirrors src/irl/room-anchor.js, irl-reactions.js). It owns:
//   • establishing a room (origin = the placer's GPS + the north reference),
//   • turning the placer's live aim (heading + distance) into the POST `room`
//     block the API expects (delegating the geometry to room-anchor.js),
//   • serialize/revive for resuming the same room across reloads.
//
// It holds NO DOM, NO network, NO Three.js — the caller wires those. Randomness
// and the location key are injected (not read here) so the functions are
// deterministic under test.

import { placeAround } from './room-anchor.js';

// Mirrors api/irl/pins.js ROOM_ID_RE / REL_MAX_M — keep in sync.
export const ROOM_ID_RE = /^[a-z0-9-]{1,64}$/;
export const REL_MAX_M = 500;

const DIST_MIN_M = 0.5;
const DIST_MAX_M = 8;
export const DIST_DEFAULT_M = 2.5;

/**
 * A stable, slug-safe room id: `r-<locationKey>-<rand>`, clamped to 64 chars and
 * normalized to the API's `^[a-z0-9-]{1,64}$`. locationKey is a coarse,
 * caller-supplied place token (e.g. a truncated geohash) so placements made at
 * the same spot in one session share a room; rand keeps two nearby rooms apart.
 */
export function makeRoomId(locationKey, rand) {
	const clean = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
	const loc = clean(locationKey) || 'room';
	const r = clean(rand) || 'x';
	return `r-${loc}-${r}`.slice(0, 64);
}

/**
 * Establish a room from the placer's current pose. The origin is their GPS; the
 * frame is true-north (originYawDeg 0) when an absolute compass heading is
 * available, otherwise it pins to the current heading and the room is a
 * relative-frame room (R2 reconciles cross-user, A3 down-weights its bearing).
 * @returns {{id,originLat,originLng,originYawDeg,absolute,createdAt,count}}
 */
export function establishRoom({ lat, lng, headingDeg = 0, hasAbsoluteCompass, locationKey, rand, now = 0 }) {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
		throw new Error('establishRoom: a GPS fix (lat/lng) is required');
	}
	const absolute = !!hasAbsoluteCompass;
	return {
		id: makeRoomId(locationKey, rand),
		originLat: lat,
		originLng: lng,
		originYawDeg: absolute ? 0 : (((headingDeg % 360) + 360) % 360),
		absolute,
		createdAt: now,
		count: 0,
	};
}

/** Clamp a distance to the aim slider's range. */
export function clampDistance(distM) {
	const d = Number(distM);
	if (!Number.isFinite(d)) return DIST_DEFAULT_M;
	return Math.min(DIST_MAX_M, Math.max(DIST_MIN_M, d));
}

/**
 * Turn the placer's live aim into everything the room-aware POST needs. The
 * placer need not stand on the origin — placeAround folds in their offset — so
 * they can walk the room dropping agents that all land in the one shared frame.
 * @returns {{ lat, lng, heading, room: {id,originLat,originLng,originYawDeg,relEast,relNorth} }}
 */
export function roomPlacement({ room, viewerLat, viewerLng, bearingDeg, distM, faceViewer = true }) {
	if (!room || !ROOM_ID_RE.test(room.id)) throw new Error('roomPlacement: a valid room is required');
	const p = placeAround({
		originLat: room.originLat,
		originLng: room.originLng,
		viewerLat, viewerLng,
		bearingDeg,
		distM: clampDistance(distM),
		faceViewer,
		originYawDeg: room.originYawDeg || 0,
	});
	return {
		lat: p.lat,
		lng: p.lng,
		heading: p.relYawDeg,
		room: {
			id: room.id,
			originLat: room.originLat,
			originLng: room.originLng,
			originYawDeg: room.originYawDeg || 0,
			relEast: p.relEast,
			relNorth: p.relNorth,
		},
	};
}

/** Serialize a room for localStorage resume. */
export function serializeRoom(room) {
	if (!room) return '';
	return JSON.stringify({
		id: room.id, originLat: room.originLat, originLng: room.originLng,
		originYawDeg: room.originYawDeg || 0, absolute: !!room.absolute,
		createdAt: room.createdAt || 0, count: room.count || 0,
	});
}

/**
 * Revive a persisted room, validating every field. Returns null on anything
 * malformed (a corrupt entry must never plant a room at 0,0 or with a bad id).
 */
export function reviveRoom(str) {
	let o;
	try { o = JSON.parse(str); } catch { return null; }
	if (!o || typeof o !== 'object') return null;
	if (!ROOM_ID_RE.test(String(o.id || ''))) return null;
	const oLat = Number(o.originLat), oLng = Number(o.originLng);
	if (!(oLat >= -90 && oLat <= 90 && oLng >= -180 && oLng <= 180)) return null;
	if (oLat === 0 && oLng === 0) return null;
	return {
		id: o.id,
		originLat: oLat,
		originLng: oLng,
		originYawDeg: ((Number(o.originYawDeg) || 0) % 360 + 360) % 360,
		absolute: !!o.absolute,
		createdAt: Number(o.createdAt) || 0,
		count: Math.max(0, Number(o.count) || 0),
	};
}

// @ts-check
// Pure marker-frame anchoring math for /irl indoor colocalization (Epic M).
//
// Why this exists
// ───────────────
// The room frame (src/irl/room-anchor.js) anchors a cluster of agents to ONE
// origin so their intra-room layout is exact for every viewer. But that origin
// is a GPS coordinate, and GPS is dead indoors: ±20–50 m, no floor, and it
// differs phone-to-phone. So "place an agent in my living room, my friend walks
// in and finds it standing in the exact spot" cannot ride GPS — two phones never
// agree on the frame.
//
// A printed/handheld VISUAL MARKER (a QR a phone can read) fixes this. The marker
// is a shared, camera-observable origin: both phones look at the SAME marker and
// each measures its 3D pose in its OWN AR session. That pose becomes the room
// origin. From there the existing room math is reused verbatim — an agent is
// stored as an exact metre offset (relEast/relNorth) from the marker, so it
// renders in the identical physical spot for whoever sees the marker, GPS-free.
//
// The one subtlety that makes this work without a shared compass: a WebXR AR
// session's world frame is gravity-aligned (Y up) but its HEADING (azimuth about
// Y) is arbitrary and differs per device. So we never express an agent in true
// north. We store its offset in the MARKER'S OWN frame (along the marker's right
// and up edges) — a frame both phones can measure directly off the QR. Each
// viewer measures the marker's azimuth in ITS session live and rotates the
// marker-local offset into its own frame. The two sessions' heading offset is
// unknown, but it cancels exactly because the stored offset is frame-independent.
// That live per-viewer yaw is the whole trick: it replaces the shared compass GPS
// rooms rely on, which is why this colocalizes indoors where compass+GPS can't.
//
// This module owns ONLY what is marker-specific and keeps it pure (no DOM, no
// Three.js, no BarcodeDetector, no I/O — plain numbers in/out so the test suite
// verifies it directly). The heavy geometry is delegated to room-anchor.js so
// there is ONE rotation and one set of conventions on every path:
//
//   • markerRoomId(payload)      — deterministic room id both phones derive from
//                                  the same QR, so neither needs GPS to find the
//                                  other's pins (the API reads by room_id).
//   • normalizeMarkerPayload     — canonicalize whatever the QR encodes so a
//                                  three.ws marker URL and its bare token hash equal.
//   • markerYawFromEdge          — the marker's world azimuth from two world
//                                  points spanning its horizontal edge.
//   • markerRelFromWorld         — a placed world point → its exact offset in the
//                                  marker's local frame (the inverse render op).
//   • markerWorldPos             — that offset back to a world position for a
//                                  viewer who has localized the marker.
//
// Coordinate conventions — IDENTICAL to src/irl.js and room-anchor.js, do not drift:
//   World:   North = −Z · East = +X · Y = up · 1 unit = 1 metre.
//   Yaw/azimuth: degrees 0–359 clockwise from world −Z (north); 0 = N, 90 = E.

import {
	agentWorldPosition,
	localToTrueNorth,
	localToBearingDistance,
} from './room-anchor.js';

// Mirrors api/irl/pins.js ROOM_ID_RE — a marker room id must satisfy it too.
const ROOM_ID_MAX = 64;
// The marker room id is `m-<hash>`; the prefix is how the render path recognises a
// marker pin (vs a GPS room `r-…`) without a schema column. Keep in sync with the
// `m-` test in markerRoomId / isMarkerRoomId.
export const MARKER_ROOM_PREFIX = 'm-';

/**
 * Canonicalize whatever a QR encodes into the stable token we hash. A three.ws
 * marker is shared as a URL (`https://three.ws/irl?m=<token>`) so it is also a
 * tappable deep link; an ad-hoc QR can hold any text. We extract the `m=` token
 * when present so the URL and the bare token resolve to the SAME marker, then
 * lower-case + trim so trivial formatting differences don't fork a room.
 *
 * @param {unknown} raw  the decoded QR string
 * @returns {string|null} the canonical token, or null if there's nothing usable
 */
export function normalizeMarkerPayload(raw) {
	if (typeof raw !== 'string') return null;
	let s = raw.trim();
	if (!s) return null;
	// Pull the `m=` parameter out of a three.ws marker link so the link and the
	// raw token collapse to one identity. Tolerant of http/https and any host —
	// the token is what identifies the marker, not where the link points.
	const m = s.match(/[?&]m=([^&#\s]+)/i);
	if (m && m[1]) {
		try { s = decodeURIComponent(m[1]); } catch { s = m[1]; }
	}
	s = s.trim().toLowerCase();
	if (!s) return null;
	// Cap to a sane length — a QR can hold ~2–4 KB, but the identity is a short
	// token. Hashing a capped slice keeps the room id bounded and the hash cheap.
	return s.slice(0, 512);
}

// FNV-1a (32-bit) — a small, fast, dependency-free string hash. We need only a
// stable, well-distributed token both phones compute identically from the same
// payload; this is not a security primitive (the QR itself is the capability).
function fnv1a(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		// h *= 16777619, kept in 32-bit via Math.imul.
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0; // unsigned
}

/**
 * The deterministic room id for a marker: `m-<base36 hash>`. Both phones derive
 * the identical id from the same QR, so the placer's pins are found by anyone who
 * scans the marker — the API reads them by room_id with no GPS gate. Always
 * satisfies api/irl/pins.js ROOM_ID_RE (`^[a-z0-9-]{1,64}$`).
 *
 * @param {unknown} payload  raw QR string (or an already-normalized token)
 * @returns {string|null} the room id, or null if the payload is unusable
 */
export function markerRoomId(payload) {
	const token = normalizeMarkerPayload(payload);
	if (!token) return null;
	// Two 32-bit halves (token + token reversed) widen the space to ~64 bits so
	// distinct markers don't collide on a room. base36 keeps it slug-safe.
	const a = fnv1a(token).toString(36);
	const b = fnv1a(token.split('').reverse().join('')).toString(36);
	return `${MARKER_ROOM_PREFIX}${a}${b}`.slice(0, ROOM_ID_MAX);
}

/**
 * Whether a room id is a marker room (vs a GPS room). The render path uses this
 * to decide a pin is localized by a visual marker, not by the viewer's GPS.
 * @param {unknown} roomId
 * @returns {boolean}
 */
export function isMarkerRoomId(roomId) {
	return typeof roomId === 'string' && roomId.startsWith(MARKER_ROOM_PREFIX);
}

/**
 * The marker's azimuth (degrees, 0–359 clockwise from the session's −Z) IN THE
 * CURRENT AR SESSION FRAME, from two world points spanning its horizontal "right"
 * edge — e.g. the marker centre and a point one edge to its right, each resolved
 * by a WebXR hit-test through the QR's detected corners. This is a per-session
 * number (the session heading is arbitrary), measured fresh by every viewer; that
 * is by design — see the module header. Keeps all camera/CV work in hit-test ray
 * space (the platform's job) and leaves this module a pure azimuth-of-a-delta,
 * reusing room-anchor's localToBearingDistance so the convention can never drift.
 *
 * The marker's local "north" (its +relNorth axis) is defined as the in-plane
 * direction 90° counter-clockwise from its right edge, matching how a viewer
 * reads the marker upright — so an agent placed "to the right of the marker as I
 * face it" lands to the right for the next viewer who faces it too.
 *
 * @param {{x:number,z:number}} centerWorld  marker centre in world (XZ)
 * @param {{x:number,z:number}} rightWorld   a point along the marker's right edge
 * @returns {number|null} azimuth degrees, or null if the points coincide
 */
export function markerYawFromEdge(centerWorld, rightWorld) {
	const dEast = rightWorld.x - centerWorld.x;       // east = +X
	const dNorth = -(rightWorld.z - centerWorld.z);   // north = −Z
	if (Math.hypot(dEast, dNorth) < 1e-4) return null; // degenerate: no edge length
	// Azimuth of the RIGHT edge. The marker frame's own north is 90° CCW of it, so
	// the stored originYawDeg (frame rotation vs true north) is rightAzimuth − 90,
	// normalized — the same originYawDeg agentWorldPosition consumes.
	const { bearingDeg } = localToBearingDistance(dEast, dNorth);
	return (((bearingDeg - 90) % 360) + 360) % 360;
}

/**
 * A placed agent's world point → its EXACT offset in the marker's local frame
 * (relEast / relNorth, metres). The inverse of {@link markerWorldPos}: it
 * un-rotates the world delta by the marker's yaw so the stored offset round-trips
 * cleanly back to world for any viewer who localizes the same marker. Mirrors
 * floor-anchor's roomRelFromGeo, but the origin is a live marker pose, not a GPS
 * index — markerYawDeg is THIS session's measured marker azimuth, not true north.
 *
 * @param {object} p
 * @param {{x:number,z:number}} p.markerWorld  marker origin in the placer's session frame (XZ)
 * @param {number} p.markerYawDeg  marker azimuth in the placer's session frame (from markerYawFromEdge)
 * @param {number} p.x  agent world X (east, +X)
 * @param {number} p.z  agent world Z (north is −Z)
 * @returns {{ relEast:number, relNorth:number }}
 */
export function markerRelFromWorld({ markerWorld, markerYawDeg = 0, x, z }) {
	const trueEast = x - markerWorld.x;
	const trueNorth = -(z - markerWorld.z); // north = −Z
	const room = markerYawDeg
		? localToTrueNorth(trueEast, trueNorth, -markerYawDeg) // inverse rotation into the marker frame
		: { east: trueEast, north: trueNorth };
	return { relEast: room.east, relNorth: room.north };
}

/**
 * The world position of a marker-anchored agent for a viewer who has localized the
 * marker. The marker pose plays the role the GPS-derived room origin plays in
 * room-anchor's agentWorldPosition — so this is that same hot-path call with the
 * marker as origin, sharing its exact rotation math (no duplicated geometry).
 *
 * @param {object} p
 * @param {{x:number,z:number}} p.markerWorld  marker origin in THIS viewer's session frame (XZ)
 * @param {number} [p.markerYawDeg]  marker azimuth in THIS viewer's session frame (from markerYawFromEdge)
 * @param {number} p.relEast   metres east of the marker (marker frame)
 * @param {number} p.relNorth  metres north of the marker (marker frame)
 * @param {number} [p.heightM] floor offset (Y) relative to the marker
 * @returns {{ x:number, y:number, z:number }}
 */
export function markerWorldPos({ markerWorld, markerYawDeg = 0, relEast, relNorth, heightM = 0 }) {
	return agentWorldPosition({
		originWorld: markerWorld,
		relEast,
		relNorth,
		heightM,
		originYawDeg: markerYawDeg,
	});
}

/**
 * Build the POST `room` block for a marker placement, ready for api/irl/pins.js.
 * A marker pin is a room pin whose id is derived from the QR and whose origin GPS
 * is only a coarse INDEX (the marker, not GPS, positions the agent). The server
 * requires a finite, non-(0,0) origin lat/lng, so the caller passes its coarse
 * fix; when none is available the caller must gate placement on a fix first
 * (the marker still needs an index row), exactly like GPS room mode.
 *
 * @param {object} p
 * @param {string} p.roomId      from {@link markerRoomId}
 * @param {number} p.indexLat    the placer's coarse fix latitude (GPS index only)
 * @param {number} p.indexLng    the placer's coarse fix longitude
 * @param {number} p.relEast     marker-frame offset east (metres)
 * @param {number} p.relNorth    marker-frame offset north (metres)
 * @returns {{ id:string, originLat:number, originLng:number, originYawDeg:number, relEast:number, relNorth:number }}
 */
export function markerRoomBlock({ roomId, indexLat, indexLng, relEast, relNorth }) {
	return {
		id: roomId,
		originLat: indexLat,
		originLng: indexLng,
		// The marker's own yaw is measured LIVE per viewer from the QR, never stored
		// in the frame — so the stored frame is north-aligned (0) and relEast/relNorth
		// are already in the marker's local axes from markerRelFromWorld.
		originYawDeg: 0,
		relEast,
		relNorth,
	};
}

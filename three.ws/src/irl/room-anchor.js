// Pure room-relative anchoring math for /irl world-locked agents.
//
// Why this exists
// ───────────────
// Today every placed agent is anchored to its OWN absolute GPS coordinate. That
// is fine at city scale ("an agent somewhere in this plaza") but it breaks at
// ROOM scale: consumer GPS is accurate to ~5–15 m, so two agents you place 3 m
// apart — one on the couch to your right, one on the wall to your left — fall
// well inside the same GPS noise. Independent per-agent GPS lets their relative
// positions smear and even swap sides, and it differs phone-to-phone, so a
// second viewer never sees the same layout.
//
// The fix is a shared ROOM FRAME. A room has ONE origin (a GPS coordinate + a
// reference bearing). Every agent in the room is stored as an EXACT offset from
// that origin in metres (relEast / relNorth) plus the bearing it faces. The
// consequences:
//
//   • Intra-room geometry is exact and identical for everyone. Couch-agent at
//     (+2 E, +1 N) and wall-agent at (−2 E, +1 N) are always 4 m apart on
//     opposite sides — GPS noise translates the WHOLE cluster together, it can
//     never smear agents relative to each other.
//   • You calibrate the ROOM ONCE, not each agent. Nudging the origin moves the
//     entire cluster, so a single "drag the room onto its real spot" gesture
//     aligns every agent at once.
//   • GPS is demoted to an INDEX: it only decides which room you load and places
//     the cluster roughly in the world. Compass north is the shared reference
//     that lets two phones agree on the frame without a visual scan.
//
// This module is the pure geometry that makes that work. No DOM, no Three.js, no
// I/O — it returns plain numbers/objects so the client constructs Vector3s and
// the test suite verifies the math directly (mirrors multiplayer/src/
// irl-reactions.js as a pure, unit-tested policy core).
//
// Coordinate conventions — IDENTICAL to src/irl.js, do not drift:
//   World:   North = −Z · East = +X · Y = up · 1 unit = 1 metre.
//   Compass: bearing 0–359° clockwise from true north (0 = N, 90 = E).
//   World yaw from a compass bearing: yaw = −(deg · π/180)  (matches pinYawRad).
//   Local→world: east → +X, north → −Z.

const DEG = Math.PI / 180;

// Metres per degree. Latitude is effectively constant; longitude shrinks with
// the cosine of latitude. We project longitude around the ORIGIN's latitude so a
// room is internally consistent (the few-metre error a degree of cos() drift
// would add only appears thousands of km away, never within one room).
export const M_PER_DEG_LAT = 110540;
export function mPerDegLng(lat) {
	return 111320 * Math.cos(lat * DEG);
}

/**
 * Metres of (lat,lng) east/north of a room origin, in the true-north frame.
 * @returns {{ east: number, north: number }}
 */
export function geoToLocal(originLat, originLng, lat, lng) {
	return {
		east: (lng - originLng) * mPerDegLng(originLat),
		north: (lat - originLat) * M_PER_DEG_LAT,
	};
}

/**
 * Inverse of {@link geoToLocal}: a true-north metre offset back to lat/lng. Used
 * to persist an agent's absolute coordinate (the GPS index + back-compat with
 * legacy clients that only read lat/lng) alongside its exact relative offset.
 * @returns {{ lat: number, lng: number }}
 */
export function localToGeo(originLat, originLng, east, north) {
	return {
		lat: originLat + north / M_PER_DEG_LAT,
		lng: originLng + east / mPerDegLng(originLat),
	};
}

/**
 * A compass bearing + distance to an east/north offset. Bearing 0 = north
 * (+north), 90 = east (+east): east = sin(b), north = cos(b).
 * @returns {{ east: number, north: number }}
 */
export function bearingDistanceToLocal(bearingDeg, distM) {
	const r = bearingDeg * DEG;
	return {
		east: distM * Math.sin(r),
		north: distM * Math.cos(r),
	};
}

/**
 * Inverse of {@link bearingDistanceToLocal} — for UI readback ("3.0 m · 92°")
 * and turning a calibration drag back into a stored bearing.
 * @returns {{ bearingDeg: number, distM: number }}
 */
export function localToBearingDistance(east, north) {
	const distM = Math.hypot(east, north);
	const bearingDeg = ((Math.atan2(east, north) / DEG) % 360 + 360) % 360;
	return { bearingDeg, distM };
}

/**
 * Rotate a room-frame offset into the true-north frame. A room whose local
 * "north" axis points at compass bearing `originYawDeg` (0 = aligned to true
 * north, the default) needs this when projecting to world. With a calibrated
 * compass every room is true-north aligned and this is identity; the rotation
 * exists for the graceful-degradation path where no absolute heading is
 * available and the creator's initial facing defines the frame instead.
 * @returns {{ east: number, north: number }}
 */
export function localToTrueNorth(relEast, relNorth, originYawDeg = 0) {
	if (!originYawDeg) return { east: relEast, north: relNorth };
	const f = originYawDeg * DEG;
	const cos = Math.cos(f), sin = Math.sin(f);
	return {
		east: relEast * cos + relNorth * sin,
		north: -relEast * sin + relNorth * cos,
	};
}

/**
 * The room origin's position in the VIEWER's world frame (relative to the
 * viewer's own GPS, which sits at the world origin). The client adds each
 * agent's relative offset to this to place it. Returns plain {x,z} so this
 * module never imports Three.js.
 * @returns {{ x: number, z: number }}
 */
export function roomOriginWorld(viewerLat, viewerLng, originLat, originLng) {
	const off = geoToLocal(viewerLat, viewerLng, originLat, originLng);
	return { x: off.east, z: -off.north }; // east → +X, north → −Z
}

/**
 * World position of an agent given its room-relative offset and the room
 * origin's already-computed world position. This is the hot-path render call.
 * @param {object} a
 * @param {{x:number,z:number}} a.originWorld  room origin in the viewer's frame
 * @param {number} a.relEast   metres east of origin (room frame)
 * @param {number} a.relNorth  metres north of origin (room frame)
 * @param {number} [a.heightM] floor offset (Y)
 * @param {number} [a.originYawDeg] room frame rotation vs true north
 * @returns {{ x: number, y: number, z: number }}
 */
export function agentWorldPosition({ originWorld, relEast, relNorth, heightM = 0, originYawDeg = 0 }) {
	const tn = localToTrueNorth(relEast, relNorth, originYawDeg);
	return {
		x: originWorld.x + tn.east,
		y: heightM,
		z: originWorld.z - tn.north, // north = −Z
	};
}

/**
 * World yaw (radians) an agent should face for a given compass bearing.
 * Re-exported so callers share src/irl.js's pinYawRad convention exactly.
 */
export function compassToYaw(deg) {
	return -(deg * DEG);
}

/**
 * The absolute lat/lng an agent should be stored at, given its UNCHANGED
 * room-frame offset and the room's (possibly recalibrated) origin. This is the
 * inverse-to-geo twin of {@link agentWorldPosition} — where that projects an
 * agent into the VIEWER's world frame, this re-derives the agent's GPS index so a
 * proximity read stays consistent after the room moves. Used by the room-scoped
 * calibrate to persist each agent's lat/lng without ever touching its relEast/
 * relNorth, so the cluster's internal layout is preserved exactly.
 * @returns {{ lat:number, lng:number }}
 */
export function pinAbsoluteFromOrigin({ originLat, originLng, originYawDeg = 0, relEast, relNorth }) {
	const tn = localToTrueNorth(relEast, relNorth, originYawDeg);
	return localToGeo(originLat, originLng, tn.east, tn.north);
}

/**
 * Apply a one-gesture ROOM calibrate to a room's origin. The owner grabs the
 * whole cluster and slides it by a true-north metre offset (dEast/dNorth) and/or
 * twists it about the origin by dYawDeg. Because every agent is rigidly tied to
 * the shared origin via its relEast/relNorth, moving the origin moves the entire
 * cluster together with its internal layout intact — no per-agent shear. The
 * agents' room-frame offsets are NOT changed here; only the origin translates and
 * the frame rotates. Pair with {@link pinAbsoluteFromOrigin} to re-derive each
 * agent's absolute lat/lng under the returned origin.
 *
 * @param {object} p
 * @param {number} p.originLat   current room origin latitude
 * @param {number} p.originLng   current room origin longitude
 * @param {number} [p.originYawDeg=0]  current room frame rotation vs true north
 * @param {number} [p.dEastM=0]   ground translation east, metres (true-north frame)
 * @param {number} [p.dNorthM=0]  ground translation north, metres
 * @param {number} [p.dYawDeg=0]  cluster rotation about the origin, degrees
 * @returns {{ originLat:number, originLng:number, originYawDeg:number }}
 */
export function calibrateRoomOrigin({ originLat, originLng, originYawDeg = 0, dEastM = 0, dNorthM = 0, dYawDeg = 0 }) {
	const moved = localToGeo(originLat, originLng, dEastM, dNorthM);
	return {
		originLat: moved.lat,
		originLng: moved.lng,
		originYawDeg: (((originYawDeg + dYawDeg) % 360) + 360) % 360,
	};
}

/**
 * "Place an agent around me." Turns the placer's live pose (where they stand +
 * which way the phone points) and a distance into a durable room-relative
 * anchor, plus the absolute lat/lng to persist for the GPS index / legacy
 * clients. The placer need not be standing on the origin — their offset from it
 * is folded in — so you can walk the room dropping agents and they all land in
 * the one shared frame.
 *
 * @param {object} p
 * @param {number} p.originLat   room origin latitude
 * @param {number} p.originLng   room origin longitude
 * @param {number} p.viewerLat   placer's current latitude
 * @param {number} p.viewerLng   placer's current longitude
 * @param {number} p.bearingDeg  compass bearing the placer is pointing (0–359)
 * @param {number} p.distM       how far ahead to drop the agent (metres)
 * @param {boolean} [p.faceViewer=true]  agent turns to face the placer (like a
 *   person you walked up to), vs. facing the same way the placer points
 * @param {number} [p.originYawDeg=0]    room frame rotation vs true north
 * @returns {{ relEast:number, relNorth:number, relYawDeg:number, lat:number, lng:number, bearingDeg:number, distM:number }}
 */
export function placeAround({
	originLat, originLng, viewerLat, viewerLng,
	bearingDeg, distM, faceViewer = true, originYawDeg = 0,
}) {
	// Where the placer stands, relative to the origin (true-north metres).
	const viewer = geoToLocal(originLat, originLng, viewerLat, viewerLng);
	// Where they're dropping the agent, relative to themselves.
	const ahead = bearingDistanceToLocal(bearingDeg, distM);
	const trueEast = viewer.east + ahead.east;
	const trueNorth = viewer.north + ahead.north;

	// Store the offset in the ROOM frame (un-rotate by the frame's orientation),
	// so a non-north room round-trips through agentWorldPosition cleanly.
	const room = originYawDeg
		? localToTrueNorth(trueEast, trueNorth, -originYawDeg) // inverse rotation
		: { east: trueEast, north: trueNorth };

	const faceBearing = faceViewer ? (bearingDeg + 180) % 360 : bearingDeg;
	const abs = localToGeo(originLat, originLng, trueEast, trueNorth);

	return {
		relEast: room.east,
		relNorth: room.north,
		relYawDeg: ((faceBearing % 360) + 360) % 360,
		lat: abs.lat,
		lng: abs.lng,
		bearingDeg: ((bearingDeg % 360) + 360) % 360,
		distM,
	};
}

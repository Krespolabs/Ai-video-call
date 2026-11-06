// @ts-check
// Pure floor-anchor math for /irl WebXR placement.
//
// Why this exists
// ───────────────
// When you place an agent on the floor with WebXR (immersive-ar), the hit-test
// gives you an anchored pose in the session's LOCAL frame: metres from the
// eye-level origin the session started at, plus the surface's orientation as a
// quaternion. To make that placement durable and shareable we must turn that
// local pose into a GPS pin — a lat/lng + a compass heading the renderer can
// reload and re-place for any viewer.
//
// That conversion is just two pieces of math: a horizontal metre-offset →
// lat/lng projection, and a quaternion → yaw-degrees extraction. The projection
// is the SAME one room-anchor.js already exports and unit-tests; duplicating its
// metre-per-degree constants on this write path is exactly how a sign error
// ships silently and lands every saved anchor in the wrong spot for every viewer.
// So this module reuses room-anchor's localToGeo and owns only the quaternion
// math — no DOM, no Three.js, no I/O, plain numbers in/out so the test suite can
// verify it directly.
//
// Coordinate conventions — IDENTICAL to src/irl.js and room-anchor.js, do not drift:
//   World:   North = −Z · East = +X · Y = up · 1 unit = 1 metre.
//   Yaw:     degrees 0–359 clockwise from the local −Z axis (what savePin stores
//            and spawnNearbyPin reads back).

import { geoToLocal, localToGeo, localToTrueNorth } from './room-anchor.js';

/**
 * Yaw (rotation about world Y) in degrees, clockwise from the local −Z axis —
 * the same convention savePin stores and spawnNearbyPin reads back. Raw output
 * is the atan2 range (−180, 180]; callers normalise to [0,360) when persisting.
 * @param {number} x quaternion x
 * @param {number} y quaternion y
 * @param {number} z quaternion z
 * @param {number} w quaternion w
 * @returns {number} yaw in degrees, in (−180, 180]
 */
export function yawDegFromQuat(x, y, z, w) {
	const siny = 2 * (w * y + z * x);
	const cosy = 1 - 2 * (y * y + x * x);
	return Math.atan2(siny, cosy) * 180 / Math.PI;
}

/**
 * Anchored local-space pose (metres from the eye-level session origin) → the GPS
 * pin to persist. Reuses room-anchor's localToGeo so there is ONE projection and
 * one set of metre-per-degree constants for both the read and write paths.
 *
 * The session frame uses the same axes as the world: +X = east, −Z = north. So
 * the local x passes straight through as east, and we pass −z as north.
 *
 * @param {object} p
 * @param {number} p.originLat  GPS latitude of the session origin (the viewer's fix)
 * @param {number} p.originLng  GPS longitude of the session origin
 * @param {number} p.x  local east offset (metres, +X)
 * @param {number} p.y  local height offset (metres, +Y up) — negative = below eye level
 * @param {number} p.z  local south offset (metres, +Z); world north is −Z
 * @param {[number, number, number, number]} p.quat  surface orientation [x,y,z,w]
 * @returns {{ lat:number, lng:number, heading:number, heightM:number, quat:[number,number,number,number], source:'webxr' }}
 */
export function anchorPoseToPin({ originLat, originLng, x, y, z, quat }) {
	const { lat, lng } = localToGeo(originLat, originLng, /* east */ x, /* north */ -z);
	const heading = ((Math.round(yawDegFromQuat(quat[0], quat[1], quat[2], quat[3])) % 360) + 360) % 360;
	return {
		lat,
		lng,
		heading,
		heightM: y, // floor height relative to the eye-level session origin (negative = below)
		quat,
		source: 'webxr',
	};
}

/**
 * An absolute lat/lng → its EXACT offset in a room's frame (relEast / relNorth,
 * metres). The inverse of room-anchor's agentWorldPosition input: it un-rotates a
 * true-north offset by the room's orientation so the stored offset round-trips
 * cleanly back to world for every viewer. Used both when a WebXR refine moves a
 * single agent and when an A3 calibrate drag repositions a ROOM pin — a room pin
 * renders from rel_*, so a calibrate that only moved lat/lng would never show.
 *
 * @param {object} p
 * @param {number} p.originLat     room origin latitude
 * @param {number} p.originLng     room origin longitude
 * @param {number} [p.originYawDeg] room frame rotation vs true north (0 = aligned)
 * @param {number} p.lat           the point's latitude
 * @param {number} p.lng           the point's longitude
 * @returns {{ relEast:number, relNorth:number }}
 */
export function roomRelFromGeo({ originLat, originLng, originYawDeg = 0, lat, lng }) {
	const off = geoToLocal(originLat, originLng, lat, lng); // true-north metres
	const room = originYawDeg
		? localToTrueNorth(off.east, off.north, -originYawDeg) // inverse rotation into the room frame
		: { east: off.east, north: off.north };
	return { relEast: room.east, relNorth: room.north };
}

/**
 * A WebXR floor hit → a durable ROOM placement. This is the precision twin of
 * room-anchor's placeAround: instead of a compass bearing + slider distance, the
 * agent's spot comes from a real on-device hit-test pose (metres from the XR
 * session origin, which sits at the viewer's GPS fix). The result is expressed in
 * the SAME shared room frame (relEast / relNorth from the room origin) so the
 * WebXR-placed agent renders identically for every viewer — WebXR only improved
 * WHERE it was captured, not how it's shared.
 *
 * The placer need not stand on the origin: their GPS offset from it is folded in,
 * exactly like placeAround, so a walked-around room stays in one frame. The XR
 * local axes match the world convention (+X = east, −Z = north), the same
 * assumption anchorPoseToPin already ships on the standalone write path.
 *
 * @param {object} p
 * @param {number} p.originLat     room origin latitude
 * @param {number} p.originLng     room origin longitude
 * @param {number} [p.originYawDeg] room frame rotation vs true north (0 = aligned)
 * @param {number} p.viewerLat     placer's current latitude (the XR session origin)
 * @param {number} p.viewerLng     placer's current longitude
 * @param {number} p.x  hit east offset from the viewer (metres, +X)
 * @param {number} p.y  hit floor height relative to the eye-level session origin (+Y up)
 * @param {number} p.z  hit south offset from the viewer (metres, +Z); world north is −Z
 * @param {[number, number, number, number]} p.quat  surface orientation [x,y,z,w]
 * @returns {{ relEast:number, relNorth:number, relYawDeg:number, lat:number, lng:number, heightM:number, quat:[number,number,number,number], source:'webxr' }}
 */
export function roomPlacementFromHit({ originLat, originLng, originYawDeg = 0, viewerLat, viewerLng, x, y, z, quat }) {
	// Hit offset from the viewer, in the project's world-aligned convention.
	const hitEast = x;
	const hitNorth = -z;
	// Where the placer stands relative to the origin (true-north metres).
	const viewer = geoToLocal(originLat, originLng, viewerLat, viewerLng);
	const trueEast = viewer.east + hitEast;
	const trueNorth = viewer.north + hitNorth;
	// Store the offset in the ROOM frame (un-rotate by the frame's orientation) so a
	// non-north room round-trips through agentWorldPosition cleanly.
	const room = originYawDeg
		? localToTrueNorth(trueEast, trueNorth, -originYawDeg)
		: { east: trueEast, north: trueNorth };
	const abs = localToGeo(originLat, originLng, trueEast, trueNorth);
	const heading = ((Math.round(yawDegFromQuat(quat[0], quat[1], quat[2], quat[3])) % 360) + 360) % 360;
	return {
		relEast: room.east,
		relNorth: room.north,
		relYawDeg: heading,
		lat: abs.lat,
		lng: abs.lng,
		heightM: y,
		quat,
		source: 'webxr',
	};
}

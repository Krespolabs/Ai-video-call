// Geohash encoder — the server-side spatial key for IRL placement density caps.
//
// A precision-7 cell is ~153m × 153m: the fine geocell D4 uses to cap how many
// agents one small area can hold (so a single actor can't carpet-bomb a plaza).
// Kept dependency-free and identical in behaviour to multiplayer/src/geohash.js
// (the matchmaking key, precision-6) so a lat/lng maps to the same lattice on
// both the realtime host and the API. Duplicated rather than cross-imported
// because Vercel bundles api/ functions in isolation from the multiplayer package.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'; // (no a, i, l, o)

/**
 * Encode a lat/lng to a geohash string of the given precision.
 * Returns '' for non-finite input so callers can treat an unplaceable point as
 * "no cell" rather than crashing the insert path.
 * @param {number} lat
 * @param {number} lng
 * @param {number} [precision=7]
 * @returns {string}
 */
export function encodeGeohash(lat, lng, precision = 7) {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
	let idx = 0;
	let bit = 0;
	let evenBit = true; // true → bisecting longitude, false → latitude
	let geohash = '';
	let latMin = -90, latMax = 90;
	let lngMin = -180, lngMax = 180;

	while (geohash.length < precision) {
		if (evenBit) {
			const mid = (lngMin + lngMax) / 2;
			if (lng >= mid) { idx = idx * 2 + 1; lngMin = mid; } else { idx = idx * 2; lngMax = mid; }
		} else {
			const mid = (latMin + latMax) / 2;
			if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; } else { idx = idx * 2; latMax = mid; }
		}
		evenBit = !evenBit;
		if (++bit === 5) {
			geohash += BASE32[idx];
			bit = 0;
			idx = 0;
		}
	}
	return geohash;
}

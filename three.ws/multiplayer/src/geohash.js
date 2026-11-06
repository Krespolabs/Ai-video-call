// Geohash (precision-6) — the coarse spatial key for the IRL world.
//
// Shared by the IrlRoom (server) and src/irl-net.js (client, bundled by Vite the
// same way it bundles schemas.js). A precision-6 cell is ~1.2km × 0.6km, the
// matchmaking key every viewer inside one cell joins (filterBy(['geocell'])).
//
// Privacy by design: the geohash IS the coarse location. A viewer's device never
// has to send precise GPS — it sends only this cell string, and the server places
// presence markers at the cell centre + bounded jitter. So "where someone is"
// never resolves finer than "somewhere in this ~1km cell."

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'; // (no a, i, l, o)

/**
 * Encode a lat/lng to a geohash string of the given precision.
 * @param {number} lat
 * @param {number} lng
 * @param {number} [precision=6]
 * @returns {string}
 */
export function encodeGeohash(lat, lng, precision = 6) {
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

/**
 * Decode a geohash to its bounding box.
 * @returns {{ latMin:number, latMax:number, lngMin:number, lngMax:number }}
 */
export function decodeGeohashBounds(geohash) {
	let evenBit = true;
	let latMin = -90, latMax = 90;
	let lngMin = -180, lngMax = 180;
	for (const ch of String(geohash || '').toLowerCase()) {
		const idx = BASE32.indexOf(ch);
		if (idx < 0) continue; // tolerate stray chars rather than throwing on the wire
		for (let n = 4; n >= 0; n--) {
			const bitN = (idx >> n) & 1;
			if (evenBit) {
				const mid = (lngMin + lngMax) / 2;
				if (bitN === 1) lngMin = mid; else lngMax = mid;
			} else {
				const mid = (latMin + latMax) / 2;
				if (bitN === 1) latMin = mid; else latMax = mid;
			}
			evenBit = !evenBit;
		}
	}
	return { latMin, latMax, lngMin, lngMax };
}

/**
 * Decode a geohash to its centre point and half-extents (degrees of error each way).
 * The half-extents bound the jitter the server adds so a presence marker stays
 * inside the cell it claims.
 * @returns {{ lat:number, lng:number, latErr:number, lngErr:number }}
 */
export function decodeGeohash(geohash) {
	const b = decodeGeohashBounds(geohash);
	return {
		lat: (b.latMin + b.latMax) / 2,
		lng: (b.lngMin + b.lngMax) / 2,
		latErr: (b.latMax - b.latMin) / 2,
		lngErr: (b.lngMax - b.lngMin) / 2,
	};
}

// ── Neighbour expansion ──────────────────────────────────────────────────────
// Standard base32 borrow tables for stepping a geohash one cell N/S/E/W. The two
// rows in each entry are for even- vs odd-length geohashes (the bit interleave
// alternates lat/lng parity by cell length). This is the canonical geohash-js
// adjacency algorithm — it handles wrap-around at the ±180° antimeridian and the
// poles by recursively carrying into the parent cell.
const ADJ_NEIGHBORS = {
	n: ['p0r21436x8zb9dcf5h7kjnmqesgutwvy', 'bc01fg45238967deuvhjyznpkmstqrwx'],
	s: ['14365h7k9dcfesgujnmqp0r2twvyx8zb', '238967debc01fg45kmstqrwxuvhjyznp'],
	e: ['bc01fg45238967deuvhjyznpkmstqrwx', 'p0r21436x8zb9dcf5h7kjnmqesgutwvy'],
	w: ['238967debc01fg45kmstqrwxuvhjyznp', '14365h7k9dcfesgujnmqp0r2twvyx8zb'],
};
const ADJ_BORDERS = {
	n: ['prxz', 'bcfguvyz'],
	s: ['028b', '0145hjnp'],
	e: ['bcfguvyz', 'prxz'],
	w: ['0145hjnp', '028b'],
};

/**
 * The geohash one cell away from `geohash` in compass direction `dir`
 * ('n' | 's' | 'e' | 'w'). Returns '' for empty/invalid input.
 */
export function geohashAdjacent(geohash, dir) {
	const gh = String(geohash || '').toLowerCase();
	const d = String(dir || '').toLowerCase();
	if (!gh || !ADJ_NEIGHBORS[d]) return '';
	const lastCh = gh.slice(-1);
	let parent = gh.slice(0, -1);
	const type = gh.length % 2; // 0 → even-length, 1 → odd-length
	// On a border cell the step carries into the parent first (wrap-around).
	if (ADJ_BORDERS[d][type].indexOf(lastCh) !== -1 && parent !== '') {
		parent = geohashAdjacent(parent, d);
	}
	const idx = ADJ_NEIGHBORS[d][type].indexOf(lastCh);
	if (idx < 0) return ''; // stray char that isn't in the base32 alphabet
	return parent + BASE32[idx];
}

/**
 * The up-to-8 geohash cells surrounding `geohash` (4 edges + 4 corners), so a
 * viewer near a cell edge still sees pins that straddle the boundary inside the
 * nearby radius. De-duplicated; never includes the centre cell itself.
 * @returns {string[]}
 */
export function geohashNeighbors(geohash) {
	const gh = String(geohash || '').toLowerCase();
	if (!gh) return [];
	const n = geohashAdjacent(gh, 'n');
	const s = geohashAdjacent(gh, 's');
	const e = geohashAdjacent(gh, 'e');
	const w = geohashAdjacent(gh, 'w');
	const cells = [
		n, s, e, w,
		geohashAdjacent(n, 'e'), geohashAdjacent(n, 'w'),
		geohashAdjacent(s, 'e'), geohashAdjacent(s, 'w'),
	];
	// De-dupe and drop empties / the centre (degenerate near the poles).
	return [...new Set(cells)].filter((c) => c && c !== gh);
}

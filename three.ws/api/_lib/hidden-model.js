// "Nobody", the agent that is not in the registry.
//
// One file in src/ is not source code: src/nobody.stl. GitHub renders .stl (and
// only .stl) in an interactive 3D viewer right inside the file page, so the
// model spins for anyone who clicks it while browsing the repo. That is the
// whole point of the easter egg: a 3D platform hides a 3D thing, and finding it
// looks like finding it.
//
// The mesh is generated here rather than checked in as opaque bytes so the
// committed artifact stays reviewable and reproducible: `npm run build:nobody`
// rewrites src/nobody.stl from this module, and tests/hidden-model.test.js
// fails when the two drift apart. The API serves the same bytes from the same
// function, so the site and the repo can never ship different models.
//
// Determinism matters here (a byte-compare gates the commit), so no
// transcendental is used anywhere in the build: the body is a 12-sided surface
// of revolution, and every cos/sin it needs at multiples of 30 degrees is a
// literal or Math.sqrt(3)/2. Math.sqrt is correctly rounded by IEEE 754, so the
// output is identical on every machine and every Node version.

// The passphrase carried in the STL's 80-byte header. Binary STL spends its
// first 80 bytes on a free-form comment that every renderer ignores and no
// viewer displays, which makes it the one place a secret can sit in plain sight
// inside a file people are looking straight at.
export const NOBODY_KEY = 'n0b0dy-3we-7ea3';

// Exactly 80 bytes once padded (asserted below).
const HEADER_TEXT = `nobody was here. bring me to three.ws/nobody :: ${NOBODY_KEY}`;

// Nobody is a sheet with a rounded head and a hem that has not settled. The
// profile below is the silhouette, bottom to top, as [radius, height]; the
// displacement pass after it waves the hem and presses two eyes into the front.
// A surface of revolution alone would have read as a chess piece (it did, twice)
// and a chess piece is not a character anyone wants to screenshot.
const PROFILE = [
	[0.0, 0.08], // underside centre
	[0.7, 0.0], // hem, waved per segment below
	[0.74, 0.3],
	[0.73, 0.6],
	[0.7, 0.9],
	[0.7, 1.22], // eye row, lower
	[0.71, 1.38], // eye row, upper
	[0.67, 1.6],
	[0.56, 1.78],
	[0.4, 1.92],
	[0.21, 2.0],
	[0.0, 2.06], // crown
];

const SEGMENTS = 16;
const HEM = 1;

// How far alternate hem points hang below their neighbours. This is the whole
// reason the shape reads as a ghost at thumbnail size rather than as a pawn.
const HEM_WAVE = 0.17;

// Two eyes, pressed into the front face at plus and minus one segment from
// dead centre. They are dents in the surface, not added geometry: an overlapping
// eyeball would z-fight in exactly the flat-shaded grey viewer this model exists
// to look good in.
const EYE_SEGMENTS = [3, 5];
const EYE_HEIGHT = 1.3;
const EYE_DEPTH = 0.36;
const EYE_SPREAD = 1.45; // falloff radius, in segment widths
const EYE_RISE = 0.26; // falloff radius, in world height

const R2 = Math.sqrt(2);
// cos/sin at every multiple of 22.5 degrees, built from square roots so the
// output is bit-identical everywhere. Math.sqrt is correctly rounded by IEEE 754;
// Math.cos is not specified to be.
const C1 = Math.sqrt(2 + R2) / 2; // cos 22.5
const C3 = Math.sqrt(2 - R2) / 2; // cos 67.5
const C2 = R2 / 2; // cos 45
const COS = [1, C1, C2, C3, 0, -C3, -C2, -C1, -1, -C1, -C2, -C3, 0, C3, C2, C1];
const SIN = [0, C3, C2, C1, 1, C1, C2, C3, 0, -C3, -C2, -C1, -1, -C1, -C2, -C3];

// Shortest distance between two segment indices, in segment widths.
function segmentDistance(a, b) {
	const d = Math.abs(a - b) % SEGMENTS;
	return Math.min(d, SEGMENTS - d);
}

// Depth of the eye dent at one grid point: a quadratic falloff in both
// directions, clamped at zero so the dent is local and the rest of the head is
// left exactly as the profile drew it.
function eyeDent(seg, height) {
	let deepest = 0;
	for (const eye of EYE_SEGMENTS) {
		const du = segmentDistance(seg, eye) / EYE_SPREAD;
		const dv = (height - EYE_HEIGHT) / EYE_RISE;
		const falloff = 1 - (du * du + dv * dv);
		if (falloff > deepest) deepest = falloff;
	}
	return EYE_DEPTH * deepest;
}

function vertex(ring, seg) {
	const s = seg % SEGMENTS;
	const [baseRadius, baseHeight] = PROFILE[ring];
	const height = ring === HEM && s % 2 === 1 ? baseHeight - HEM_WAVE : baseHeight;
	const radius = baseRadius === 0 ? 0 : Math.max(0.05, baseRadius - eyeDent(s, height));
	return [radius * COS[s], height, radius * SIN[s]];
}

// Outward normal of a counter-clockwise triangle. A zero-area triangle (the two
// poles produce none here, but a future profile edit could) falls back to +Y
// rather than emitting NaN, which is what makes a mesh vanish in a viewer.
function faceNormal(a, b, c) {
	const ux = b[0] - a[0];
	const uy = b[1] - a[1];
	const uz = b[2] - a[2];
	const vx = c[0] - a[0];
	const vy = c[1] - a[1];
	const vz = c[2] - a[2];
	const nx = uy * vz - uz * vy;
	const ny = uz * vx - ux * vz;
	const nz = ux * vy - uy * vx;
	const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
	if (!len) return [0, 1, 0];
	return [nx / len, ny / len, nz / len];
}

// The triangle list, as [v0, v1, v2] triples wound counter-clockwise seen from
// outside. Poles collapse to a single triangle per segment; every other band is
// two triangles per segment.
export function nobodyTriangles() {
	const tris = [];
	for (let ring = 0; ring < PROFILE.length - 1; ring += 1) {
		const bottomPole = PROFILE[ring][0] === 0;
		const topPole = PROFILE[ring + 1][0] === 0;
		for (let seg = 0; seg < SEGMENTS; seg += 1) {
			const a = vertex(ring, seg);
			const b = vertex(ring, seg + 1);
			const c = vertex(ring + 1, seg + 1);
			const d = vertex(ring + 1, seg);
			if (bottomPole) tris.push([a, c, d]);
			else if (topPole) tris.push([a, b, c]);
			else tris.push([a, b, c], [a, c, d]);
		}
	}
	return tris;
}

// Binary STL: 80-byte header, uint32 triangle count, then 50 bytes per triangle
// (normal + three vertices as float32 LE, plus the attribute short every writer
// leaves at zero).
export function buildNobodyStl() {
	const header = Buffer.alloc(80, 0x20);
	header.write(HEADER_TEXT, 0, 'ascii');
	const tris = nobodyTriangles();
	const body = Buffer.alloc(4 + tris.length * 50);
	body.writeUInt32LE(tris.length, 0);
	let off = 4;
	for (const [a, b, c] of tris) {
		const n = faceNormal(a, b, c);
		for (const v of [n, a, b, c]) {
			body.writeFloatLE(v[0], off);
			body.writeFloatLE(v[1], off + 4);
			body.writeFloatLE(v[2], off + 8);
			off += 12;
		}
		body.writeUInt16LE(0, off);
		off += 2;
	}
	return Buffer.concat([header, body]);
}

// Read the header comment back out of any binary STL. The /nobody page uses this
// to prove to a finder that the bytes they are holding are the bytes we shipped.
export function readStlHeader(bytes) {
	return Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, 80)
		.toString('ascii')
		.replace(/[\s\0]+$/, '');
}

if (Buffer.byteLength(HEADER_TEXT, 'ascii') > 80) {
	throw new Error(`nobody.stl header is ${Buffer.byteLength(HEADER_TEXT, 'ascii')} bytes, max 80`);
}

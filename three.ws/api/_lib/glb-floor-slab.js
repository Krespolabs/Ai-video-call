// Strip the floor slab an image-to-3D reconstructor fuses under a resting object.
//
// TRELLIS and Hunyuan3D both read "an object sitting on the ground" into their
// input, even from a clean alpha cutout, and answer with the subject standing on
// a thin, wide plate: a teapot on a marble square, a telescope on a grey sheet.
// The plate belongs to the same mesh, so every viewer, download and AR launch
// shows it. glb-quality.js already notices the resulting shape (`planar`) and
// asks vision QA to judge it, but that only helps while a vision provider
// answers; this pass removes the defect itself, on geometry alone.
//
// What counts as a fused slab, measured in world space with +Y up (glTF):
//   - a bottom band, the lowest SLAB_BAND of the model's height, holds a real
//     share of the triangles;
//   - the geometry ABOVE that band is a real subject, not a sliver;
//   - the band is a solid sheet: seen from above it fills its bounding rectangle
//     (SLAB_FILL). Measured on live results, a fused plate fills 1.000 of it,
//     while feet, legs and a rigged figure's soles fill 0.03 to 0.42, and even a
//     round lamp foot tops out near 0.79;
//   - the sheet is wider than the subject standing on it (SLAB_FOOTPRINT_RATIO).
// A genuinely flat subject (a plate, a rug, a coin) has almost nothing above the
// band and is left alone. A thick base (a plinth) rises above the band, so its
// top face widens the subject's footprint and the model is left alone too.
//
// Only the part of the plate outside where the subject touches down is cut; the
// patch directly under it stays, so the subject never loses its own underside. The
// pass is pure, CPU-only and best-effort: anything it cannot read or decide
// returns the original bytes.

import { Buffer } from 'node:buffer';

// The bottom band, as a fraction of the model's height. A fused plate measured
// on live results is 1-3% of the height thick.
export const SLAB_BAND = 0.05;
// Geometry counts as "subject" only above this fraction of the height, which
// keeps the plate's own rim out of the subject's footprint.
const SUBJECT_FLOOR = 0.08;
// The subject's contact footprint: the part of it below this fraction of the
// height, which is where it rests on the plate. The cut keeps the plate only
// under this, so a teapot keeps a sliver under its foot rather than a ring under
// its flared body, and a tripod keeps a small pad under each foot. Measured on
// live results: 0.2 left a visible ragged ring round a teapot, 0.08 does not.
const CONTACT_CEILING = 0.08;
// The band must fill at least this share of its bounding rectangle, seen from
// above, to be a sheet rather than feet, legs or a rounded foot.
export const SLAB_FILL = 0.9;
// And be at least this many times wider (by XZ footprint area) than the subject.
export const SLAB_FOOTPRINT_RATIO = 1.25;
// Resolution of the top-down coverage grid the fill is measured on.
const FILL_GRID = 48;
// Resolution of the contact mask the cut follows.
const CONTACT_GRID = 64;
// Minimum shares of all triangles for the band and for the subject.
const MIN_BAND_SHARE = 0.01;
const MIN_SUBJECT_SHARE = 0.2;
// The subject's footprint grows by this fraction of its extent before cutting,
// so a flared foot or a soft shadow edge on the subject is never trimmed.
const FOOTPRINT_MARGIN = 0.1;

function worldPositions(prim, matrix) {
	const pos = prim.getAttribute('POSITION');
	const n = pos.getCount();
	const out = new Float64Array(n * 3);
	const v = [0, 0, 0];
	const m = matrix;
	for (let i = 0; i < n; i++) {
		pos.getElement(i, v);
		out[i * 3] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
		out[i * 3 + 1] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
		out[i * 3 + 2] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
	}
	return out;
}

function triangleIndices(prim) {
	const idx = prim.getIndices();
	if (idx) return Array.from(idx.getArray());
	const n = prim.getAttribute('POSITION').getCount();
	return Array.from({ length: n - (n % 3) }, (_, i) => i);
}

function emptyBox() {
	return { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
}

function grow(box, x, z) {
	if (x < box.minX) box.minX = x;
	if (x > box.maxX) box.maxX = x;
	if (z < box.minZ) box.minZ = z;
	if (z > box.maxZ) box.maxZ = z;
}

function area(box) {
	return box.maxX > box.minX && box.maxZ > box.minZ ? (box.maxX - box.minX) * (box.maxZ - box.minZ) : 0;
}

// Rasterize the triangles `pick` selects onto a g x g grid over `box`, seen from
// above: a cell is covered when its centre falls inside any picked triangle.
// With `edges`, a triangle's edges mark the cells they cross too, because a
// vertical wall has no area from above and would otherwise vanish.
function rasterize(parts, pick, box, g, { edges = false } = {}) {
	const w = box.maxX - box.minX;
	const d = box.maxZ - box.minZ;
	if (!(w > 0 && d > 0)) return null;
	const cells = new Uint8Array(g * g);
	const cell = (v, lo, span) => Math.min(g - 1, Math.max(0, Math.floor(((v - lo) / span) * g)));
	for (const { positions: p, indices } of parts) {
		for (let t = 0; t + 2 < indices.length; t += 3) {
			if (!pick(p, indices, t)) continue;
			const ax = p[indices[t] * 3], az = p[indices[t] * 3 + 2];
			const bx = p[indices[t + 1] * 3], bz = p[indices[t + 1] * 3 + 2];
			const cx = p[indices[t + 2] * 3], cz = p[indices[t + 2] * 3 + 2];
			if (edges) {
				for (const [x0e, z0e, x1e, z1e] of [[ax, az, bx, bz], [bx, bz, cx, cz], [cx, cz, ax, az]]) {
					const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1e - x0e) / w, Math.abs(z1e - z0e) / d) * g * 2));
					for (let k = 0; k <= steps; k++) {
						const ex = x0e + ((x1e - x0e) * k) / steps;
						const ez = z0e + ((z1e - z0e) * k) / steps;
						cells[cell(ez, box.minZ, d) * g + cell(ex, box.minX, w)] = 1;
					}
				}
			}
			const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
			if (Math.abs(den) < 1e-12) continue;
			const x0 = cell(Math.min(ax, bx, cx), box.minX, w), x1 = cell(Math.max(ax, bx, cx), box.minX, w);
			const z0 = cell(Math.min(az, bz, cz), box.minZ, d), z1 = cell(Math.max(az, bz, cz), box.minZ, d);
			for (let gz = z0; gz <= z1; gz++) {
				const pz = box.minZ + ((gz + 0.5) / g) * d;
				for (let gx = x0; gx <= x1; gx++) {
					if (cells[gz * g + gx]) continue;
					const px = box.minX + ((gx + 0.5) / g) * w;
					const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
					const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
					if (l1 >= -1e-6 && l2 >= -1e-6 && 1 - l1 - l2 >= -1e-6) cells[gz * g + gx] = 1;
				}
			}
		}
	}
	return cells;
}

// Share of the band's bounding rectangle its triangles cover, seen from above.
function coverage(parts, isBand, box) {
	const cells = rasterize(parts, isBand, box, FILL_GRID);
	if (!cells) return 0;
	let covered = 0;
	for (const c of cells) covered += c;
	return covered / cells.length;
}

// Where the subject touches down, as a top-down mask: the contact layer
// rasterized over its own bounds (plus the margin), with everything it encloses
// filled in (a box's walls enclose its whole bottom face, a teapot's lower curve
// its foot), then grown by one cell so the plate directly under an edge is kept
// rather than nibbled.
function contactMask(parts, isContact, box) {
	const g = CONTACT_GRID;
	const cells = rasterize(parts, isContact, box, g, { edges: true });
	if (!cells) return null;
	// Flood the open floor in from the border; any uncovered cell it cannot
	// reach is enclosed by the subject and belongs to its footprint.
	const outside = new Uint8Array(cells.length);
	const queue = [];
	for (let i = 0; i < g; i++) {
		for (const c of [i, (g - 1) * g + i, i * g, i * g + g - 1]) {
			if (!cells[c] && !outside[c]) {
				outside[c] = 1;
				queue.push(c);
			}
		}
	}
	while (queue.length) {
		const c = queue.pop();
		const x = c % g, z = (c - x) / g;
		for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
			if (nx < 0 || nz < 0 || nx >= g || nz >= g) continue;
			const n = nz * g + nx;
			if (!cells[n] && !outside[n]) {
				outside[n] = 1;
				queue.push(n);
			}
		}
	}
	for (let c = 0; c < cells.length; c++) if (!outside[c]) cells[c] = 1;
	const grown = new Uint8Array(cells.length);
	for (let z = 0; z < g; z++) {
		for (let x = 0; x < g; x++) {
			if (!cells[z * g + x]) continue;
			for (let dz = -1; dz <= 1; dz++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nz = z + dz, nx = x + dx;
					if (nz >= 0 && nz < g && nx >= 0 && nx < g) grown[nz * g + nx] = 1;
				}
			}
		}
	}
	const w = box.maxX - box.minX;
	const d = box.maxZ - box.minZ;
	return (px, pz) => {
		if (px < box.minX || px > box.maxX || pz < box.minZ || pz > box.maxZ) return false;
		const gx = Math.min(g - 1, Math.floor(((px - box.minX) / w) * g));
		const gz = Math.min(g - 1, Math.floor(((pz - box.minZ) / d) * g));
		return grown[gz * g + gx] === 1;
	};
}

/**
 * Decide whether a set of triangles is a subject fused onto a floor slab, and
 * which triangles are the slab outside the subject's footprint. Pure: takes
 * world-space positions and triangle index lists, returns a verdict.
 *
 * @param {Array<{ positions: Float64Array, indices: number[] }>} parts
 * @returns {{ slab: boolean, reason: string, remove?: Array<Set<number>>, removedTriangles?: number, footprintRatio?: number, fill?: number }}
 */
export function detectFloorSlab(parts) {
	let minY = Infinity;
	let maxY = -Infinity;
	for (const { positions } of parts) {
		for (let i = 1; i < positions.length; i += 3) {
			if (positions[i] < minY) minY = positions[i];
			if (positions[i] > maxY) maxY = positions[i];
		}
	}
	const height = maxY - minY;
	if (!(height > 0)) return { slab: false, reason: 'no_height' };
	const bandTop = minY + SLAB_BAND * height;
	const subjectFloor = minY + SUBJECT_FLOOR * height;
	const contactTop = minY + CONTACT_CEILING * height;
	const inBand = (p, idx, t) =>
		Math.max(p[idx[t] * 3 + 1], p[idx[t + 1] * 3 + 1], p[idx[t + 2] * 3 + 1]) <= bandTop;
	const inContact = (p, idx, t) =>
		!inBand(p, idx, t) && Math.min(p[idx[t] * 3 + 1], p[idx[t + 1] * 3 + 1], p[idx[t + 2] * 3 + 1]) <= contactTop;

	let total = 0;
	let bandTris = 0;
	let subjectTris = 0;
	const band = emptyBox();
	const subject = emptyBox();
	const contact = emptyBox();
	for (const { positions: p, indices } of parts) {
		for (let t = 0; t + 2 < indices.length; t += 3) {
			total++;
			const a = indices[t] * 3;
			const b = indices[t + 1] * 3;
			const c = indices[t + 2] * 3;
			const low = Math.max(p[a + 1], p[b + 1], p[c + 1]) <= bandTop;
			const high = Math.min(p[a + 1], p[b + 1], p[c + 1]) > subjectFloor;
			if (low) {
				bandTris++;
				for (const k of [a, b, c]) grow(band, p[k], p[k + 2]);
			} else if (high) {
				subjectTris++;
				for (const k of [a, b, c]) grow(subject, p[k], p[k + 2]);
			}
			if (!low && Math.min(p[a + 1], p[b + 1], p[c + 1]) <= contactTop) {
				for (const k of [a, b, c]) grow(contact, p[k], p[k + 2]);
			}
		}
	}
	if (!total) return { slab: false, reason: 'no_triangles' };
	if (bandTris / total < MIN_BAND_SHARE) return { slab: false, reason: 'no_floor_band' };
	if (subjectTris / total < MIN_SUBJECT_SHARE) return { slab: false, reason: 'flat_subject' };
	const subjectArea = area(subject);
	const footprintRatio = subjectArea > 0 ? area(band) / subjectArea : Infinity;
	if (footprintRatio < SLAB_FOOTPRINT_RATIO) return { slab: false, reason: 'base_fits_subject', footprintRatio };
	const fill = coverage(parts, inBand, band);
	if (fill < SLAB_FILL) return { slab: false, reason: 'band_not_a_sheet', footprintRatio, fill };

	const rest = area(contact) > 0 ? contact : subject;
	const mx = (rest.maxX - rest.minX) * FOOTPRINT_MARGIN;
	const mz = (rest.maxZ - rest.minZ) * FOOTPRINT_MARGIN;
	const keepBox = { minX: rest.minX - mx, maxX: rest.maxX + mx, minZ: rest.minZ - mz, maxZ: rest.maxZ + mz };
	const underSubject =
		(area(contact) > 0 && contactMask(parts, inContact, keepBox)) ||
		((x, z) => x >= keepBox.minX && x <= keepBox.maxX && z >= keepBox.minZ && z <= keepBox.maxZ);
	let removedTriangles = 0;
	const remove = parts.map(({ positions: p, indices }) => {
		const drop = new Set();
		for (let t = 0; t + 2 < indices.length; t += 3) {
			const a = indices[t] * 3;
			const b = indices[t + 1] * 3;
			const c = indices[t + 2] * 3;
			if (Math.max(p[a + 1], p[b + 1], p[c + 1]) > bandTop) continue;
			const cx = (p[a] + p[b] + p[c]) / 3;
			const cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
			if (!underSubject(cx, cz)) {
				drop.add(t);
				removedTriangles++;
			}
		}
		return drop;
	});
	if (!removedTriangles) return { slab: false, reason: 'nothing_outside_footprint', footprintRatio, fill };
	return { slab: true, reason: 'floor_slab', remove, removedTriangles, footprintRatio, fill };
}

/**
 * Remove a fused floor slab from a GLB. Returns the original bytes untouched
 * when no slab is found.
 *
 * @param {Buffer|Uint8Array} buf - source GLB bytes
 * @returns {Promise<{ buffer: Buffer, stripped: boolean, reason: string, removedTriangles: number, footprintRatio?: number, fill?: number }>}
 */
export async function stripFloorSlab(buf) {
	const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	const { NodeIO } = await import('@gltf-transform/core');
	const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
	const { compactPrimitive, prune } = await import('@gltf-transform/functions');
	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
	const doc = await io.readBinary(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));

	// A primitive can be drawn by several nodes; measure every placement, but
	// only a primitive drawn exactly once can be edited without changing the
	// other copies, so a shared primitive vetoes the edit.
	const entries = [];
	const seen = new Map();
	for (const node of doc.getRoot().listNodes()) {
		const mesh = node.getMesh();
		if (!mesh) continue;
		const matrix = node.getWorldMatrix();
		for (const prim of mesh.listPrimitives()) {
			if (prim.getMode() !== 4 || !prim.getAttribute('POSITION')) continue;
			seen.set(prim, (seen.get(prim) || 0) + 1);
			entries.push({ prim, positions: worldPositions(prim, matrix), indices: triangleIndices(prim) });
		}
	}
	const unchanged = (reason, extra = {}) => ({ buffer: input, stripped: false, reason, removedTriangles: 0, ...extra });
	if (!entries.length) return unchanged('no_triangles');

	const verdict = detectFloorSlab(entries);
	if (!verdict.slab) return unchanged(verdict.reason, { footprintRatio: verdict.footprintRatio, fill: verdict.fill });
	if (entries.some(({ prim }) => seen.get(prim) > 1)) return unchanged('shared_primitive');

	entries.forEach(({ prim, indices }, i) => {
		const drop = verdict.remove[i];
		if (!drop.size) return;
		const kept = [];
		for (let t = 0; t + 2 < indices.length; t += 3) {
			if (!drop.has(t)) kept.push(indices[t], indices[t + 1], indices[t + 2]);
		}
		const vertexCount = prim.getAttribute('POSITION').getCount();
		const array = vertexCount > 65535 ? new Uint32Array(kept) : new Uint16Array(kept);
		// A fresh accessor, never an in-place write: an index accessor can be
		// shared with a primitive this pass is not editing. prune() drops the old one.
		const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
		prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(array).setBuffer(buffer));
		// Drop the vertices only the cut triangles used, so the file shrinks too.
		compactPrimitive(prim);
	});
	await doc.transform(prune());
	const out = Buffer.from(await io.writeBinary(doc));
	return {
		buffer: out,
		stripped: true,
		reason: verdict.reason,
		removedTriangles: verdict.removedTriangles,
		footprintRatio: verdict.footprintRatio,
		fill: verdict.fill,
	};
}

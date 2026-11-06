/**
 * Floor-slab strip (api/_lib/glb-floor-slab.js).
 *
 * TRELLIS and Hunyuan3D fuse a thin, wide plate under a resting subject (a
 * teapot on a marble square). These scenes are real GLBs built with the same
 * @gltf-transform the pass reads them with, one per rule: a subject on a fused
 * plate loses the plate, while a flat subject, a thick plinth, a round lamp foot
 * and a tripod's feet are all left alone.
 */
import { describe, it, expect } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { stripFloorSlab, detectFloorSlab } from '../../api/_lib/glb-floor-slab.js';
import { scoreGlbQuality } from '../../api/_lib/glb-quality.js';

// Geometry builders. Every face is subdivided, as a reconstructor's mesh is, so
// the lowest ring of a wall never reaches down into the floor band.
function quad(tris, a, b, c, d) {
	tris.push([a, b, c], [a, c, d]);
}
function plate(tris, x0, x1, z0, z1, y, n = 12) {
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			const xa = x0 + ((x1 - x0) * i) / n, xb = x0 + ((x1 - x0) * (i + 1)) / n;
			const za = z0 + ((z1 - z0) * j) / n, zb = z0 + ((z1 - z0) * (j + 1)) / n;
			quad(tris, [xa, y, za], [xb, y, za], [xb, y, zb], [xa, y, zb]);
		}
	}
}
function box(tris, x0, x1, y0, y1, z0, z1, n = 10) {
	plate(tris, x0, x1, z0, z1, y0, n);
	plate(tris, x0, x1, z0, z1, y1, n);
	for (let i = 0; i < n; i++) {
		const ya = y0 + ((y1 - y0) * i) / n, yb = y0 + ((y1 - y0) * (i + 1)) / n;
		for (let j = 0; j < n; j++) {
			const xa = x0 + ((x1 - x0) * j) / n, xb = x0 + ((x1 - x0) * (j + 1)) / n;
			const za = z0 + ((z1 - z0) * j) / n, zb = z0 + ((z1 - z0) * (j + 1)) / n;
			quad(tris, [xa, ya, z0], [xb, ya, z0], [xb, yb, z0], [xa, yb, z0]);
			quad(tris, [xa, ya, z1], [xb, ya, z1], [xb, yb, z1], [xa, yb, z1]);
			quad(tris, [x0, ya, za], [x0, ya, zb], [x0, yb, zb], [x0, yb, za]);
			quad(tris, [x1, ya, za], [x1, ya, zb], [x1, yb, zb], [x1, yb, za]);
		}
	}
}
function disk(tris, r, y, segs = 96, rings = 6) {
	for (let k = 0; k < rings; k++) {
		const r0 = (r * k) / rings, r1 = (r * (k + 1)) / rings;
		for (let s = 0; s < segs; s++) {
			const a0 = (2 * Math.PI * s) / segs, a1 = (2 * Math.PI * (s + 1)) / segs;
			const p = (rr, a) => [rr * Math.cos(a), y, rr * Math.sin(a)];
			quad(tris, p(r0, a0), p(r1, a0), p(r1, a1), p(r0, a1));
		}
	}
}

// One node, one indexed primitive: the shape cleanup leaves a forge mesh in.
async function toGlb(tris) {
	const doc = new Document();
	const buffer = doc.createBuffer();
	const positions = new Float32Array(tris.flat(2));
	const indices = new Uint32Array(tris.length * 3).map((_, i) => i);
	const prim = doc
		.createPrimitive()
		.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
		.setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
	const node = doc.createNode().setMesh(doc.createMesh().addPrimitive(prim));
	doc.createScene().addChild(node);
	return Buffer.from(await new NodeIO().writeBinary(doc));
}

function parts(tris) {
	return [{ positions: Float64Array.from(tris.flat(2)), indices: tris.map((_, i) => [i * 3, i * 3 + 1, i * 3 + 2]).flat() }];
}

function subjectOnPlate() {
	const plateTris = [];
	plate(plateTris, -3, 3, -3, 3, 0, 24);
	plate(plateTris, -3, 3, -3, 3, 0.02, 24);
	const subjectTris = [];
	box(subjectTris, -0.5, 0.5, 0.02, 1.02, -0.5, 0.5);
	return { plateTris, subjectTris, all: [...plateTris, ...subjectTris] };
}

describe('detectFloorSlab', () => {
	it('finds a subject fused onto a wide, solid plate', () => {
		const v = detectFloorSlab(parts(subjectOnPlate().all));
		expect(v.slab).toBe(true);
		expect(v.fill).toBeGreaterThan(0.95);
		expect(v.footprintRatio).toBeGreaterThan(10);
	});

	it('leaves a genuinely flat subject alone', () => {
		const tris = [];
		plate(tris, -2, 2, -2, 2, 0, 16);
		plate(tris, -2, 2, -2, 2, 0.02, 16);
		expect(detectFloorSlab(parts(tris)).slab).toBe(false);
	});

	it('leaves a single flat sheet alone: there is nothing standing on it', () => {
		const tris = [];
		plate(tris, -2, 2, -2, 2, 0, 16);
		expect(detectFloorSlab(parts(tris)).slab).toBe(false);
	});

	it('leaves a thick plinth alone, because its top widens the subject', () => {
		const tris = [];
		box(tris, -1, 1, 0, 0.3, -1, 1);
		box(tris, -0.5, 0.5, 0.3, 1.3, -0.5, 0.5);
		expect(detectFloorSlab(parts(tris))).toMatchObject({ slab: false, reason: 'base_fits_subject' });
	});

	it('leaves a round lamp foot alone, because it is not a filled sheet', () => {
		const tris = [];
		disk(tris, 1.5, 0);
		disk(tris, 1.5, 0.02);
		box(tris, -0.05, 0.05, 0.02, 1.5, -0.05, 0.05);
		box(tris, -0.6, 0.6, 1.5, 2, -0.6, 0.6);
		const v = detectFloorSlab(parts(tris));
		expect(v).toMatchObject({ slab: false, reason: 'band_not_a_sheet' });
		expect(v.fill).toBeLessThan(0.85);
	});

	it("leaves a tripod's feet alone", () => {
		const tris = [];
		for (const [x, z] of [[-1, -1], [1, -1], [0, 1]]) box(tris, x - 0.05, x + 0.05, 0, 1.5, z - 0.05, z + 0.05);
		box(tris, -0.3, 0.3, 1.5, 1.8, -0.3, 0.3);
		expect(detectFloorSlab(parts(tris)).slab).toBe(false);
	});
});

describe('stripFloorSlab', () => {
	it('cuts the plate outside the subject and keeps every subject triangle', async () => {
		const { plateTris, subjectTris, all } = subjectOnPlate();
		const input = await toGlb(all);
		const before = scoreGlbQuality(input).metrics;
		const r = await stripFloorSlab(input);
		expect(r.stripped).toBe(true);
		expect(r.removedTriangles).toBeGreaterThan(plateTris.length * 0.8);
		const after = scoreGlbQuality(r.buffer).metrics;
		expect(after.triangleCount).toBe(before.triangleCount - r.removedTriangles);
		expect(after.triangleCount).toBeGreaterThanOrEqual(subjectTris.length);
		// The model no longer reads as a pancake to the cheap scorer.
		expect(before.planar).toBe(true);
		expect(after.planar).toBe(false);
		expect(r.buffer.length).toBeLessThan(input.length);
	});

	it('returns the original bytes when there is no slab', async () => {
		const tris = [];
		box(tris, -1, 1, 0, 0.3, -1, 1);
		box(tris, -0.5, 0.5, 0.3, 1.3, -0.5, 0.5);
		const input = await toGlb(tris);
		const r = await stripFloorSlab(input);
		expect(r.stripped).toBe(false);
		expect(r.buffer).toBe(input);
	});

	it('throws on a non-GLB buffer so the caller ships the original', async () => {
		await expect(stripFloorSlab(Buffer.from('not a glb'))).rejects.toThrow();
	});
});

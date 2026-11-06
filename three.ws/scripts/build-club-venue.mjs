#!/usr/bin/env node
/**
 * Authors public/club/venue/club-venue.glb — the nightclub interior the
 * /club page parents the rest of its geometry to. Composed at build time
 * from procedural box / cylinder geometry via @gltf-transform/core so the
 * runtime gets a real .glb file (no primitives stamped at runtime) and the
 * named-empty contract documented in src/club-venue.js + LICENSES.md is
 * satisfied without depending on a third-party asset drop.
 *
 * Run via: npm run build:club-venue
 *
 * The geometry intentionally stays plain — the visual richness comes from
 * the HDRI environment + the per-pole spotlights + the bloom postFX layer.
 * Every named empty (truss_*, stage_*, backstage_door_*, bar_*) maps to the
 * analytical POLES layout in src/club.js so dancers land on stage geometry
 * even before any artist-authored venue replaces this generated build.
 *
 * Underscore separators are deliberate: three.js's GLTFLoader runs
 * PropertyBinding.sanitizeNodeName on every node and strips `[ ] . : /` from
 * the name, so an empty authored as `stage.01` would arrive at runtime as
 * `stage01` and the named-empty contract in src/club-venue.js would fail to
 * resolve it. Keep mesh nodes underscore-prefixed too so the e2e test that
 * traverses the loaded GLB can rely on a single naming convention.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'public/club/venue');

// Mirror the layout constants from src/club.js so the named empties land on
// the same world positions the analytical POLES array does — that way the
// dancer rigs sit on top of the stage discs without the runtime needing any
// per-asset offset table.
const STAGE_RADIUS = 4.2;
const POLE_COUNT = 4;
const FLOOR_RADIUS = 14;
const ROOM_HEIGHT = 8;
const TRUSS_Y = 6.0;
const BAR_Z = -7.5;

// ─── Geometry primitives (positions / normals / indices, no UVs) ────────────

function boxGeom(sx, sy, sz) {
	const x = sx / 2;
	const y = sy / 2;
	const z = sz / 2;
	const faces = [
		{
			n: [1, 0, 0],
			v: [
				[x, -y, -z],
				[x, y, -z],
				[x, y, z],
				[x, -y, z],
			],
		},
		{
			n: [-1, 0, 0],
			v: [
				[-x, -y, z],
				[-x, y, z],
				[-x, y, -z],
				[-x, -y, -z],
			],
		},
		{
			n: [0, 1, 0],
			v: [
				[-x, y, -z],
				[-x, y, z],
				[x, y, z],
				[x, y, -z],
			],
		},
		{
			n: [0, -1, 0],
			v: [
				[-x, -y, z],
				[-x, -y, -z],
				[x, -y, -z],
				[x, -y, z],
			],
		},
		{
			n: [0, 0, 1],
			v: [
				[-x, -y, z],
				[x, -y, z],
				[x, y, z],
				[-x, y, z],
			],
		},
		{
			n: [0, 0, -1],
			v: [
				[x, -y, -z],
				[-x, -y, -z],
				[-x, y, -z],
				[x, y, -z],
			],
		},
	];
	const positions = [];
	const normals = [];
	const indices = [];
	for (const face of faces) {
		const start = positions.length / 3;
		for (const p of face.v) {
			positions.push(...p);
			normals.push(...face.n);
		}
		indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
	}
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

function discGeom(radius, segments = 96, normalY = 1) {
	const positions = [0, 0, 0];
	const normals = [0, normalY, 0];
	const indices = [];
	for (let i = 0; i <= segments; i++) {
		const theta = (i / segments) * Math.PI * 2;
		positions.push(radius * Math.cos(theta), 0, radius * Math.sin(theta));
		normals.push(0, normalY, 0);
	}
	for (let i = 0; i < segments; i++) {
		if (normalY > 0) indices.push(0, i + 1, i + 2);
		else indices.push(0, i + 2, i + 1);
	}
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

function cylinderSideGeom(radius, height, segments = 32) {
	const positions = [];
	const normals = [];
	const indices = [];
	for (let i = 0; i <= segments; i++) {
		const theta = (i / segments) * Math.PI * 2;
		const cosT = Math.cos(theta);
		const sinT = Math.sin(theta);
		positions.push(radius * cosT, height, radius * sinT);
		normals.push(cosT, 0, sinT);
		positions.push(radius * cosT, 0, radius * sinT);
		normals.push(cosT, 0, sinT);
	}
	for (let i = 0; i < segments; i++) {
		const a = i * 2;
		indices.push(a, a + 1, a + 2);
		indices.push(a + 1, a + 3, a + 2);
	}
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

// ─── glTF helpers ────────────────────────────────────────────────────────────

function addPrim(doc, buffer, mat, name, { positions, normals, indices }) {
	const posAcc = doc
		.createAccessor(`${name}.pos`)
		.setType('VEC3')
		.setArray(positions)
		.setBuffer(buffer);
	const normAcc = doc
		.createAccessor(`${name}.norm`)
		.setType('VEC3')
		.setArray(normals)
		.setBuffer(buffer);
	const idxAcc = doc
		.createAccessor(`${name}.idx`)
		.setType('SCALAR')
		.setArray(indices)
		.setBuffer(buffer);
	const prim = doc
		.createPrimitive()
		.setAttribute('POSITION', posAcc)
		.setAttribute('NORMAL', normAcc)
		.setIndices(idxAcc)
		.setMaterial(mat);
	return doc.createMesh(name).addPrimitive(prim);
}

function addMesh(doc, scene, buffer, mat, name, geom, translation = [0, 0, 0], rotation = null) {
	const mesh = addPrim(doc, buffer, mat, name, geom);
	const node = doc.createNode(name).setMesh(mesh).setTranslation(translation);
	if (rotation) node.setRotation(rotation);
	scene.addChild(node);
	return node;
}

function addEmpty(doc, scene, name, translation) {
	// Named empty = glTF Node with no mesh attached. Three.js exposes these
	// as Object3D instances which collectVenueEmpties() picks up by .name.
	const node = doc.createNode(name).setTranslation(translation);
	scene.addChild(node);
	return node;
}

// ─── Materials ───────────────────────────────────────────────────────────────

function floorMat(doc) {
	return doc
		.createMaterial('VenueFloor')
		.setBaseColorFactor([0.072, 0.031, 0.059, 1])
		.setMetallicFactor(0.65)
		.setRoughnessFactor(0.4);
}

function wallMat(doc) {
	return doc
		.createMaterial('VenueWall')
		.setBaseColorFactor([0.039, 0.02, 0.051, 1])
		.setMetallicFactor(0.2)
		.setRoughnessFactor(0.7);
}

function ceilingMat(doc) {
	return doc
		.createMaterial('VenueCeiling')
		.setBaseColorFactor([0.027, 0.012, 0.035, 1])
		.setMetallicFactor(0.15)
		.setRoughnessFactor(0.8);
}

function trussMat(doc) {
	return doc
		.createMaterial('VenueTruss')
		.setBaseColorFactor([0.11, 0.118, 0.13, 1])
		.setMetallicFactor(0.92)
		.setRoughnessFactor(0.45);
}

function barMat(doc) {
	return doc
		.createMaterial('VenueBar')
		.setBaseColorFactor([0.153, 0.078, 0.145, 1])
		.setMetallicFactor(0.7)
		.setRoughnessFactor(0.4)
		.setEmissiveFactor([0.063, 0.02, 0.059]);
}

function neonMat(doc) {
	return doc
		.createMaterial('VenueNeon')
		.setBaseColorFactor([1, 1, 1, 1])
		.setMetallicFactor(0.1)
		.setRoughnessFactor(0.45)
		.setEmissiveFactor([1.0, 0.235, 0.839]);
}

function doorMat(doc) {
	return doc
		.createMaterial('VenueDoor')
		.setBaseColorFactor([0.067, 0.039, 0.094, 1])
		.setMetallicFactor(0.55)
		.setRoughnessFactor(0.55);
}

function danceFloorMat(doc) {
	return doc
		.createMaterial('VenueDanceFloor')
		.setBaseColorFactor([0.102, 0.039, 0.122, 1])
		.setMetallicFactor(0.85)
		.setRoughnessFactor(0.25)
		.setEmissiveFactor([0.133, 0.039, 0.212]);
}

// ─── Pole layout (mirrors src/club.js POLES) ─────────────────────────────────

function poleLayouts() {
	const out = [];
	for (let i = 0; i < POLE_COUNT; i += 1) {
		const t = POLE_COUNT === 1 ? 0.5 : i / (POLE_COUNT - 1);
		const angle = -Math.PI * 0.31 + t * Math.PI * 0.62;
		const id = String(i + 1).padStart(2, '0');
		const x = Math.sin(angle) * STAGE_RADIUS;
		const z = -Math.cos(angle) * STAGE_RADIUS + 1.4;
		const backstageX = Math.sin(angle) * (STAGE_RADIUS + 0.6);
		const backstageZ = -Math.cos(angle) * (STAGE_RADIUS + 0.6) - 2.4;
		out.push({ id, x, z, backstageX, backstageZ });
	}
	return out;
}

// ─── Document build ──────────────────────────────────────────────────────────

function buildVenueDoc() {
	const doc = new Document();
	doc.createBuffer();
	const buffer = doc.getRoot().listBuffers()[0];
	const scene = doc.createScene('VenueScene');

	const floor = floorMat(doc);
	const wall = wallMat(doc);
	const ceiling = ceilingMat(doc);
	const truss = trussMat(doc);
	const bar = barMat(doc);
	const neon = neonMat(doc);
	const door = doorMat(doc);
	const dance = danceFloorMat(doc);

	// Floor — large dark metallic disc, receiveShadow at runtime.
	addMesh(doc, scene, buffer, floor, 'venue_floor', discGeom(FLOOR_RADIUS, 96, 1), [0, 0, 0]);

	// Dance-floor inlay — slightly emissive checker so the room reads as a
	// club, not an empty plane. Sits 1 mm above the main floor to avoid
	// z-fighting under bloom.
	addMesh(
		doc,
		scene,
		buffer,
		dance,
		'venue_dancefloor',
		discGeom(STAGE_RADIUS + 1.4, 64, 1),
		[0, 0.001, 0],
	);

	// Inverse disc as the ceiling — receives no shadows but seals the room
	// against the fog so we don't see fog "leaking" up to infinity.
	addMesh(doc, scene, buffer, ceiling, 'venue_ceiling', discGeom(FLOOR_RADIUS, 48, -1), [
		0,
		ROOM_HEIGHT,
		0,
	]);

	// Cylinder side wall — interior of the room. Negative scale on Y would
	// flip the inward normal; we use the inward normal directly to keep the
	// math obvious. boxGeom can't approximate a tube cleanly so we use
	// cylinderSideGeom and re-orient normals to point inward via material
	// `doubleSided` flag.
	const wallNode = addMesh(
		doc,
		scene,
		buffer,
		wall,
		'venue_wall',
		cylinderSideGeom(FLOOR_RADIUS - 0.1, ROOM_HEIGHT, 64),
		[0, 0, 0],
	);
	wallNode.getMesh().listPrimitives()[0].getMaterial().setDoubleSided(true);

	// Bar counter behind the dance floor — long box across negative Z.
	addMesh(doc, scene, buffer, bar, 'venue_bar', boxGeom(9.0, 1.1, 0.9), [0, 0.55, BAR_Z]);

	// Bar back-splash neon — emissive plane just above the counter top.
	addMesh(doc, scene, buffer, neon, 'venue_bar_backsplash', boxGeom(8.0, 0.18, 0.04), [
		0,
		1.55,
		BAR_Z - 0.45,
	]);

	// Truss — four cross-room beams. Heavy enough to read as metal under
	// the spotlights but kept low-poly: each beam is a single box.
	const beamThickness = 0.16;
	addMesh(
		doc,
		scene,
		buffer,
		truss,
		'venue_truss_front',
		boxGeom(FLOOR_RADIUS * 1.6, beamThickness, beamThickness),
		[0, TRUSS_Y, 1.4],
	);
	addMesh(
		doc,
		scene,
		buffer,
		truss,
		'venue_truss_mid',
		boxGeom(FLOOR_RADIUS * 1.6, beamThickness, beamThickness),
		[0, TRUSS_Y, -2.6],
	);
	addMesh(
		doc,
		scene,
		buffer,
		truss,
		'venue_truss_back',
		boxGeom(FLOOR_RADIUS * 1.6, beamThickness, beamThickness),
		[0, TRUSS_Y, BAR_Z + 1.0],
	);
	addMesh(
		doc,
		scene,
		buffer,
		truss,
		'venue_truss_left',
		boxGeom(beamThickness, beamThickness, 12),
		[-7.5, TRUSS_Y, -2.4],
	);
	addMesh(
		doc,
		scene,
		buffer,
		truss,
		'venue_truss_right',
		boxGeom(beamThickness, beamThickness, 12),
		[7.5, TRUSS_Y, -2.4],
	);

	// Per-pole backstage doors — narrow vertical boxes against the back wall.
	const poles = poleLayouts();
	for (const p of poles) {
		addMesh(doc, scene, buffer, door, `venue_door_${p.id}`, boxGeom(0.9, 2.2, 0.08), [
			p.backstageX,
			1.1,
			p.backstageZ - 0.05,
		]);
	}

	// ─── Named empties (the contract enforced in src/club-venue.js) ──────────

	// Mirrorball anchor — centered above the dance floor.
	addEmpty(doc, scene, 'truss_mirrorball', [0, TRUSS_Y - 0.4, -1.4]);

	// Bar backsplash neon anchor — at the centre of the emissive strip.
	addEmpty(doc, scene, 'bar_backsplash_neon', [0, 1.55, BAR_Z - 0.43]);

	// Per-slot stage / backstage / spot empties. Indices are 01..0N
	// (zero-padded) so artists can re-order discs without renaming empties.
	for (const p of poles) {
		addEmpty(doc, scene, `stage_${p.id}`, [p.x, 0, p.z]);
		addEmpty(doc, scene, `backstage_door_${p.id}`, [p.backstageX, 0, p.backstageZ]);
		addEmpty(doc, scene, `truss_spot_${p.id}`, [p.x, TRUSS_Y - 0.2, p.z + 0.5]);
	}

	return doc;
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const io = new NodeIO();
	const doc = buildVenueDoc();
	const bytes = await io.writeBinary(doc);
	const outPath = resolve(OUT_DIR, 'club-venue.glb');
	writeFileSync(outPath, Buffer.from(bytes));
	console.log(`[club-venue] wrote club-venue.glb ${(bytes.length / 1024).toFixed(1)} kB`);
}

main().catch((err) => {
	console.error('[club-venue] build failed:', err);
	process.exit(1);
});

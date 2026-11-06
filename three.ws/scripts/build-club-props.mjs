#!/usr/bin/env node
/**
 * Authors the static props used by /club — pole.glb and stage.glb — and writes
 * them to public/club/props/. Composed at build time from procedural cylinder,
 * box, torus and disc geometry via @gltf-transform/core, so the browser ships
 * a real .glb file with named empties for the spotlight + LED strip attach
 * points consumed by src/club.js.
 *
 * Run via: npm run build:club-props
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'public/club/props');

const POLE_HEIGHT = 3.6;
const POLE_RADIUS = 0.035;
const STAGE_RADIUS = 1.1;
const STAGE_HEIGHT = 0.18;

// ─── Geometry builders (positions / normals / indices, no UVs) ───────────────

/**
 * Open-top cylinder side wall + two end caps. radiusTop/radiusBottom support
 * the flared base; segments controls smoothness.
 */
function cylinderGeom(radiusTop, radiusBottom, height, segments = 24) {
	const positions = [];
	const normals = [];
	const indices = [];
	const halfH = height / 2;

	// Side ring vertices, duplicated per ring (top + bottom).
	for (let i = 0; i <= segments; i++) {
		const u = i / segments;
		const theta = u * Math.PI * 2;
		const sin = Math.sin(theta);
		const cos = Math.cos(theta);
		// Slope of the side normal so the lighting reads smoothly on a flared cone.
		const slope = (radiusBottom - radiusTop) / height;
		const nLen = Math.hypot(1, slope);
		const nx = cos / nLen;
		const nz = sin / nLen;
		const ny = slope / nLen;

		positions.push(radiusTop * cos, halfH, radiusTop * sin);
		normals.push(nx, ny, nz);
		positions.push(radiusBottom * cos, -halfH, radiusBottom * sin);
		normals.push(nx, ny, nz);
	}
	for (let i = 0; i < segments; i++) {
		const a = i * 2;
		indices.push(a, a + 1, a + 2);
		indices.push(a + 1, a + 3, a + 2);
	}

	// Top + bottom caps as triangle fans.
	const addCap = (y, radius, normalY) => {
		const centerIdx = positions.length / 3;
		positions.push(0, y, 0);
		normals.push(0, normalY, 0);
		const ringStart = positions.length / 3;
		for (let i = 0; i <= segments; i++) {
			const theta = (i / segments) * Math.PI * 2;
			positions.push(radius * Math.cos(theta), y, radius * Math.sin(theta));
			normals.push(0, normalY, 0);
		}
		for (let i = 0; i < segments; i++) {
			if (normalY > 0) {
				indices.push(centerIdx, ringStart + i, ringStart + i + 1);
			} else {
				indices.push(centerIdx, ringStart + i + 1, ringStart + i);
			}
		}
	};
	addCap(halfH, radiusTop, 1);
	addCap(-halfH, radiusBottom, -1);

	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

function boxGeom(sx, sy, sz) {
	const x = sx / 2,
		y = sy / 2,
		z = sz / 2;
	const faces = [
		// +X
		{
			n: [1, 0, 0],
			v: [
				[x, -y, -z],
				[x, y, -z],
				[x, y, z],
				[x, -y, z],
			],
		},
		// -X
		{
			n: [-1, 0, 0],
			v: [
				[-x, -y, z],
				[-x, y, z],
				[-x, y, -z],
				[-x, -y, -z],
			],
		},
		// +Y
		{
			n: [0, 1, 0],
			v: [
				[-x, y, -z],
				[-x, y, z],
				[x, y, z],
				[x, y, -z],
			],
		},
		// -Y
		{
			n: [0, -1, 0],
			v: [
				[-x, -y, z],
				[-x, -y, -z],
				[x, -y, -z],
				[x, -y, z],
			],
		},
		// +Z
		{
			n: [0, 0, 1],
			v: [
				[-x, -y, z],
				[x, -y, z],
				[x, y, z],
				[-x, y, z],
			],
		},
		// -Z
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

function torusGeom(radius, tube, radialSegments = 8, tubularSegments = 64) {
	const positions = [];
	const normals = [];
	const indices = [];
	for (let j = 0; j <= radialSegments; j++) {
		for (let i = 0; i <= tubularSegments; i++) {
			const u = (i / tubularSegments) * Math.PI * 2;
			const v = (j / radialSegments) * Math.PI * 2;
			const cosU = Math.cos(u),
				sinU = Math.sin(u);
			const cosV = Math.cos(v),
				sinV = Math.sin(v);
			positions.push(
				(radius + tube * cosV) * cosU,
				tube * sinV,
				(radius + tube * cosV) * sinU,
			);
			normals.push(cosV * cosU, sinV, cosV * sinU);
		}
	}
	const stride = tubularSegments + 1;
	for (let j = 0; j < radialSegments; j++) {
		for (let i = 0; i < tubularSegments; i++) {
			const a = j * stride + i;
			const b = a + stride;
			indices.push(a, b, a + 1);
			indices.push(b, b + 1, a + 1);
		}
	}
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

// ─── glTF assembly helpers ───────────────────────────────────────────────────

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
	const node = doc.createNode(name).setTranslation(translation);
	scene.addChild(node);
	return node;
}

function chromeMat(doc) {
	return doc
		.createMaterial('PoleChrome')
		.setBaseColorFactor([0.902, 0.91, 0.941, 1])
		.setMetallicFactor(1.0)
		.setRoughnessFactor(0.14);
}

function brushedMat(doc) {
	return doc
		.createMaterial('PoleBrushed')
		.setBaseColorFactor([0.784, 0.8, 0.847, 1])
		.setMetallicFactor(0.95)
		.setRoughnessFactor(0.32);
}

function darkMetalMat(doc) {
	return doc
		.createMaterial('DarkMetal')
		.setBaseColorFactor([0.102, 0.11, 0.126, 1])
		.setMetallicFactor(0.9)
		.setRoughnessFactor(0.45);
}

function stageBodyMat(doc) {
	return doc
		.createMaterial('StageBody')
		.setBaseColorFactor([0.039, 0.02, 0.051, 1])
		.setMetallicFactor(0.55)
		.setRoughnessFactor(0.55);
}

function stageTopMat(doc) {
	return doc
		.createMaterial('StageTop')
		.setBaseColorFactor([0.094, 0.035, 0.102, 1])
		.setMetallicFactor(0.7)
		.setRoughnessFactor(0.35);
}

function ledMat(doc) {
	return doc
		.createMaterial('StageLED')
		.setBaseColorFactor([1, 1, 1, 1])
		.setEmissiveFactor([1.0, 0.3, 0.84])
		.setMetallicFactor(0.1)
		.setRoughnessFactor(0.4);
}

// ─── Pole ────────────────────────────────────────────────────────────────────

function buildPoleDoc() {
	const doc = new Document();
	doc.createBuffer();
	const buffer = doc.getRoot().listBuffers()[0];
	const scene = doc.createScene('PoleScene');

	const chrome = chromeMat(doc);
	const brushed = brushedMat(doc);
	const dark = darkMetalMat(doc);

	// Flared base disc.
	addMesh(
		doc,
		scene,
		buffer,
		brushed,
		'pole.base',
		cylinderGeom(0.42, 0.46, 0.04, 40),
		[0, 0.02, 0],
	);

	// Transition collar between base and shaft.
	addMesh(
		doc,
		scene,
		buffer,
		brushed,
		'pole.collar',
		cylinderGeom(POLE_RADIUS * 2.1, 0.13, 0.09, 32),
		[0, 0.04 + 0.045, 0],
	);

	// Main shaft.
	addMesh(
		doc,
		scene,
		buffer,
		chrome,
		'pole.shaft',
		cylinderGeom(POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 24),
		[0, POLE_HEIGHT / 2, 0],
	);

	// Ceiling mount plate.
	addMesh(doc, scene, buffer, brushed, 'pole.mount.plate', boxGeom(0.26, 0.014, 0.26), [
		0,
		POLE_HEIGHT + 0.007,
		0,
	]);

	// Four bolts on the mount plate.
	const boltGeom = cylinderGeom(0.012, 0.012, 0.022, 8);
	const boltInset = 0.1;
	const boltOffsets = [
		[+boltInset, +boltInset],
		[+boltInset, -boltInset],
		[-boltInset, +boltInset],
		[-boltInset, -boltInset],
	];
	for (let i = 0; i < boltOffsets.length; i++) {
		const [bx, bz] = boltOffsets[i];
		addMesh(doc, scene, buffer, dark, `pole.bolt.${i}`, boltGeom, [
			bx,
			POLE_HEIGHT + 0.024,
			bz,
		]);
	}

	// Spotlight bracket.
	addMesh(doc, scene, buffer, dark, 'pole.bracket.arm', boxGeom(0.04, 0.02, 0.18), [
		0,
		POLE_HEIGHT + 0.024,
		0.13,
	]);
	// Rotate +90° about X so the cylinder's Y axis points along Z (head pointing forward).
	// Quaternion for 90° X-rotation: (sin(45°), 0, 0, cos(45°)).
	const xQuat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
	addMesh(
		doc,
		scene,
		buffer,
		dark,
		'pole.bracket.head',
		cylinderGeom(0.025, 0.025, 0.04, 16),
		[0, POLE_HEIGHT + 0.024, 0.22],
		xQuat,
	);

	// Spotlight attach empty (consumed by prompt 04).
	// Underscored — three.js's PropertyBinding.sanitizeNodeName strips `.`
	// from glTF node names, so `pole.light.attach` would arrive at runtime as
	// `polelightattach`. Match the convention used by club-venue.glb.
	addEmpty(doc, scene, 'pole_light_attach', [0, POLE_HEIGHT + 0.024, 0.24]);

	return doc;
}

// ─── Stage ───────────────────────────────────────────────────────────────────

function buildStageDoc() {
	const doc = new Document();
	doc.createBuffer();
	const buffer = doc.getRoot().listBuffers()[0];
	const scene = doc.createScene('StageScene');

	const body = stageBodyMat(doc);
	const top = stageTopMat(doc);
	const led = ledMat(doc);

	// Main disc (slight outward flare at the base).
	addMesh(
		doc,
		scene,
		buffer,
		body,
		'stage.body',
		cylinderGeom(STAGE_RADIUS, STAGE_RADIUS + 0.04, STAGE_HEIGHT, 64),
		[0, STAGE_HEIGHT / 2, 0],
	);

	// Anti-slip top face — recessed slightly inside the disc rim.
	addMesh(
		doc,
		scene,
		buffer,
		top,
		'stage.top',
		cylinderGeom(STAGE_RADIUS - 0.01, STAGE_RADIUS - 0.01, 0.004, 64),
		[0, STAGE_HEIGHT + 0.002, 0],
	);

	// LED strip — horizontal torus around the top edge.
	const xQuat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
	addMesh(
		doc,
		scene,
		buffer,
		led,
		'stage.led.ring',
		torusGeom(STAGE_RADIUS + 0.005, 0.012, 8, 96),
		[0, STAGE_HEIGHT - 0.014, 0],
		xQuat,
	);

	// LED control empty (consumed by prompt 04).
	addEmpty(doc, scene, 'stage_led_strip', [0, STAGE_HEIGHT - 0.014, 0]);

	return doc;
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const io = new NodeIO();

	const targets = [
		{ name: 'pole.glb', doc: buildPoleDoc() },
		{ name: 'stage.glb', doc: buildStageDoc() },
	];

	for (const { name, doc } of targets) {
		const bytes = await io.writeBinary(doc);
		const outPath = resolve(OUT_DIR, name);
		writeFileSync(outPath, Buffer.from(bytes));
		console.log(`[club-props] wrote ${name.padEnd(10)} ${(bytes.length / 1024).toFixed(1)} kB`);
	}
}

main().catch((err) => {
	console.error('[club-props] build failed:', err);
	process.exit(1);
});

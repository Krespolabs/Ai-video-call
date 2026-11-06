#!/usr/bin/env node
/**
 * Authors the six walk-page environments under public/environments/<name>/.
 *
 *   <name>/scene.glb    — the environment's scenery as a real glTF binary,
 *                         composed at build time from procedural geometry via
 *                         @gltf-transform/core (no primitives stamped at
 *                         runtime). Every top-level node sits at its (x, 0, z)
 *                         ground position; the walk page snaps each onto the
 *                         terrain surface at load. `void` ships no GLB — it is
 *                         a procedural grid floor built in src/walk-environments.js.
 *   <name>/env.hdr      — equirectangular Radiance RGBE the page pre-filters
 *                         through PMREMGenerator.fromEquirectangular() to drive
 *                         PBR reflections (image-based lighting). `void` ships
 *                         none (its IBL is a flat dark wash).
 *   <name>/preview.jpg  — 256×256 thumbnail rendered for the HUD picker.
 *   index.json          — the manifest the runtime loads first: per-environment
 *                         terrain tint, sky gradient, light rig, env-map
 *                         intensity, static colliders, and dynamic-prop counts.
 *
 * Run via: npm run build:walk-environments
 *
 * Why synthesise instead of shipping third-party downloads: like /club
 * (scripts/build-club-hdri.mjs, build-club-venue.mjs) the walk page requires
 * every committed asset to have crystal-clear provenance. These are authored
 * and owned by three.ws, dedicated CC0 1.0 — see
 * public/environments/LICENSES.md. A studio could drop a richer artist GLB /
 * Polyhaven HDR into any <name>/ directory and update the manifest to upgrade
 * fidelity later; the contract (node naming + collider list) is documented here.
 *
 * Underscore separators in node names are deliberate: three.js's GLTFLoader
 * runs PropertyBinding.sanitizeNodeName and strips `[ ] . : /`, so `tree.01`
 * would arrive as `tree01`. Keep names underscore-delimited.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'public/environments');

// ─── Colour helpers ──────────────────────────────────────────────────────────
// glTF baseColor / emissive factors are LINEAR; HUD/CSS colours are sRGB hex.

function hexToRgb(hex) {
	const h = hex.replace('#', '');
	return [
		parseInt(h.slice(0, 2), 16) / 255,
		parseInt(h.slice(2, 4), 16) / 255,
		parseInt(h.slice(4, 6), 16) / 255,
	];
}
function srgbToLinear(c) {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function lin(hex) {
	return hexToRgb(hex).map(srgbToLinear);
}

// ─── Geometry primitives (positions / normals / indices, no UVs) ─────────────
// All builders place their base at local y = 0 so a node translation of
// (x, 0, z) drops the prop onto the ground; the runtime then adds terrain
// height. Apex/top features bake their own y-offset into the vertices.

function boxGeom(sx, sy, sz, baseY = 0) {
	const x = sx / 2;
	const z = sz / 2;
	const y0 = baseY;
	const y1 = baseY + sy;
	const faces = [
		{
			n: [1, 0, 0],
			v: [
				[x, y0, -z],
				[x, y1, -z],
				[x, y1, z],
				[x, y0, z],
			],
		},
		{
			n: [-1, 0, 0],
			v: [
				[-x, y0, z],
				[-x, y1, z],
				[-x, y1, -z],
				[-x, y0, -z],
			],
		},
		{
			n: [0, 1, 0],
			v: [
				[-x, y1, -z],
				[-x, y1, z],
				[x, y1, z],
				[x, y1, -z],
			],
		},
		{
			n: [0, -1, 0],
			v: [
				[-x, y0, z],
				[-x, y0, -z],
				[x, y0, -z],
				[x, y0, z],
			],
		},
		{
			n: [0, 0, 1],
			v: [
				[-x, y0, z],
				[x, y0, z],
				[x, y1, z],
				[-x, y1, z],
			],
		},
		{
			n: [0, 0, -1],
			v: [
				[x, y0, -z],
				[-x, y0, -z],
				[-x, y1, -z],
				[x, y1, -z],
			],
		},
	];
	const positions = [];
	const normals = [];
	const indices = [];
	for (const f of faces) {
		const s = positions.length / 3;
		for (const p of f.v) {
			positions.push(...p);
			normals.push(...f.n);
		}
		indices.push(s, s + 1, s + 2, s, s + 2, s + 3);
	}
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

// Capped cylinder, base at y0, top at y0+height. radiusTop lets it taper
// (trunks, pedestals, lamp posts).
function cylinderGeom(radiusBottom, radiusTop, height, y0 = 0, segments = 20) {
	const positions = [];
	const normals = [];
	const indices = [];
	const y1 = y0 + height;
	// Side wall.
	for (let i = 0; i <= segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		const c = Math.cos(t);
		const s = Math.sin(t);
		positions.push(radiusTop * c, y1, radiusTop * s);
		normals.push(c, 0, s);
		positions.push(radiusBottom * c, y0, radiusBottom * s);
		normals.push(c, 0, s);
	}
	for (let i = 0; i < segments; i++) {
		const a = i * 2;
		indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
	}
	// Top cap.
	const topCenter = positions.length / 3;
	positions.push(0, y1, 0);
	normals.push(0, 1, 0);
	const topStart = positions.length / 3;
	for (let i = 0; i <= segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		positions.push(radiusTop * Math.cos(t), y1, radiusTop * Math.sin(t));
		normals.push(0, 1, 0);
	}
	for (let i = 0; i < segments; i++) indices.push(topCenter, topStart + i, topStart + i + 1);
	// Bottom cap.
	const botCenter = positions.length / 3;
	positions.push(0, y0, 0);
	normals.push(0, -1, 0);
	const botStart = positions.length / 3;
	for (let i = 0; i <= segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		positions.push(radiusBottom * Math.cos(t), y0, radiusBottom * Math.sin(t));
		normals.push(0, -1, 0);
	}
	for (let i = 0; i < segments; i++) indices.push(botCenter, botStart + i + 1, botStart + i);
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

// Cone, base ring at y0, apex at y0+height.
function coneGeom(radius, height, y0 = 0, segments = 16) {
	const positions = [];
	const normals = [];
	const indices = [];
	const apexY = y0 + height;
	const slant = Math.hypot(radius, height) || 1;
	const ny = radius / slant;
	const nr = height / slant;
	for (let i = 0; i < segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		const tm = ((i + 0.5) / segments) * Math.PI * 2;
		const c = Math.cos(t);
		const s = Math.sin(t);
		const c2 = Math.cos(((i + 1) / segments) * Math.PI * 2);
		const s2 = Math.sin(((i + 1) / segments) * Math.PI * 2);
		const base = positions.length / 3;
		positions.push(radius * c, y0, radius * s);
		normals.push(nr * c, ny, nr * s);
		positions.push(radius * c2, y0, radius * s2);
		normals.push(nr * c2, ny, nr * s2);
		positions.push(0, apexY, 0);
		normals.push(nr * Math.cos(tm), ny, nr * Math.sin(tm));
		indices.push(base, base + 1, base + 2);
	}
	// Base cap.
	const center = positions.length / 3;
	positions.push(0, y0, 0);
	normals.push(0, -1, 0);
	const start = positions.length / 3;
	for (let i = 0; i <= segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		positions.push(radius * Math.cos(t), y0, radius * Math.sin(t));
		normals.push(0, -1, 0);
	}
	for (let i = 0; i < segments; i++) indices.push(center, start + i + 1, start + i);
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

// Low-poly UV sphere centred at (0, cy, 0).
function sphereGeom(radius, cy = 0, segs = 14, rings = 10) {
	const positions = [];
	const normals = [];
	const indices = [];
	for (let r = 0; r <= rings; r++) {
		const phi = (r / rings) * Math.PI;
		const y = Math.cos(phi);
		const rr = Math.sin(phi);
		for (let s = 0; s <= segs; s++) {
			const theta = (s / segs) * Math.PI * 2;
			const nx = rr * Math.cos(theta);
			const nz = rr * Math.sin(theta);
			positions.push(nx * radius, cy + y * radius, nz * radius);
			normals.push(nx, y, nz);
		}
	}
	const row = segs + 1;
	for (let r = 0; r < rings; r++) {
		for (let s = 0; s < segs; s++) {
			const a = r * row + s;
			const b = a + row;
			indices.push(a, b, a + 1, a + 1, b, b + 1);
		}
	}
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

// ─── glTF assembly ───────────────────────────────────────────────────────────

function makeMaterial(doc, name, { color, metal = 0, rough = 0.85, emissive = null, opacity = 1 }) {
	const [r, g, b] = lin(color);
	const m = doc
		.createMaterial(name)
		.setBaseColorFactor([r, g, b, opacity])
		.setMetallicFactor(metal)
		.setRoughnessFactor(rough);
	if (opacity < 1) m.setAlphaMode('BLEND');
	if (emissive) m.setEmissiveFactor(lin(emissive));
	return m;
}

function addPrim(doc, buffer, mat, name, { positions, normals, indices }) {
	const prim = doc
		.createPrimitive()
		.setAttribute(
			'POSITION',
			doc.createAccessor(`${name}.pos`).setType('VEC3').setArray(positions).setBuffer(buffer),
		)
		.setAttribute(
			'NORMAL',
			doc.createAccessor(`${name}.norm`).setType('VEC3').setArray(normals).setBuffer(buffer),
		)
		.setIndices(
			doc.createAccessor(`${name}.idx`).setType('SCALAR').setArray(indices).setBuffer(buffer),
		)
		.setMaterial(mat);
	return prim;
}

// One node = one prop, possibly several primitives (trunk + foliage), placed at
// (x, 0, z). The runtime snaps node.y to the terrain surface on load.
function addProp(doc, scene, buffer, name, parts, x, z, rotationY = 0) {
	const mesh = doc.createMesh(name);
	parts.forEach((p, i) => mesh.addPrimitive(addPrim(doc, buffer, p.mat, `${name}_${i}`, p.geom)));
	const node = doc.createNode(name).setMesh(mesh).setTranslation([x, 0, z]);
	if (rotationY) node.setRotation([0, Math.sin(rotationY / 2), 0, Math.cos(rotationY / 2)]);
	scene.addChild(node);
	return node;
}

// ─── Deterministic PRNG so every build produces byte-identical assets ─────────
function makeRng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

// ═════════════════════════════════════════════════════════════════════════════
// Per-environment scene builders. Each returns `{ colliders }`; the meshes are
// added straight onto the gltf-transform scene. Colliders carry absolute (x, z)
// + dimensions — the runtime resolves y from the terrain height.
// ═════════════════════════════════════════════════════════════════════════════

function buildPark(doc, scene, buffer) {
	const rng = makeRng(701);
	const colliders = [];
	const trunkMat = makeMaterial(doc, 'ParkTrunk', { color: '#5c3a1e', rough: 0.95 });
	const foliageMat = makeMaterial(doc, 'ParkFoliage', { color: '#2f7d32', rough: 0.85 });
	const benchMat = makeMaterial(doc, 'ParkBench', { color: '#6b4423', rough: 0.8 });
	const lampPost = makeMaterial(doc, 'ParkLampPost', {
		color: '#2a2a2a',
		metal: 0.6,
		rough: 0.5,
	});
	const lampGlow = makeMaterial(doc, 'ParkLampGlow', {
		color: '#fff3c4',
		emissive: '#ffe9a8',
		rough: 0.4,
	});
	const bushMat = makeMaterial(doc, 'ParkBush', { color: '#3c8d3a', rough: 0.9 });

	const TREES = 16;
	for (let i = 0; i < TREES; i++) {
		const angle = (i / TREES) * Math.PI * 2 + rng() * 0.4;
		const r = 5.5 + rng() * 4.5;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const sc = 0.85 + rng() * 0.5;
		addProp(
			doc,
			scene,
			buffer,
			`tree_${i}`,
			[
				{ geom: cylinderGeom(0.12 * sc, 0.09 * sc, 0.9 * sc, 0), mat: trunkMat },
				{ geom: coneGeom(0.78 * sc, 1.5 * sc, 0.7 * sc), mat: foliageMat },
				{ geom: coneGeom(0.6 * sc, 1.1 * sc, 1.4 * sc), mat: foliageMat },
			],
			x,
			z,
			rng() * Math.PI,
		);
		colliders.push({ type: 'cylinder', x, z, radius: 0.3 * sc, halfHeight: 0.9 * sc });
	}

	// Scattered bushes — soft, non-colliding ground cover.
	for (let i = 0; i < 10; i++) {
		const angle = rng() * Math.PI * 2;
		const r = 2.6 + rng() * 6.5;
		addProp(
			doc,
			scene,
			buffer,
			`bush_${i}`,
			[{ geom: sphereGeom(0.4 + rng() * 0.2, 0.32), mat: bushMat }],
			Math.cos(angle) * r,
			Math.sin(angle) * r,
		);
	}

	// Two benches flanking the spawn — seat slab, two leg blocks, a backrest.
	for (const [bi, bx, bz, by] of [
		[0, -2.6, 1.4, 0.5],
		[1, 2.6, -1.6, -0.6],
	]) {
		addProp(
			doc,
			scene,
			buffer,
			`bench_${bi}`,
			[
				{ geom: boxGeom(1.5, 0.08, 0.42, 0.42), mat: benchMat },
				{ geom: translateX(boxGeom(0.1, 0.42, 0.42, 0), -0.62), mat: benchMat },
				{ geom: translateX(boxGeom(0.1, 0.42, 0.42, 0), 0.62), mat: benchMat },
				{ geom: translateZ(boxGeom(1.5, 0.4, 0.06, 0.5), -0.18), mat: benchMat },
			],
			bx,
			bz,
			by,
		);
		colliders.push({ type: 'box', x: bx, z: bz, hx: 0.75, hy: 0.42, hz: 0.21, rotationY: by });
	}

	// Lamp posts.
	for (let i = 0; i < 4; i++) {
		const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
		const r = 3.4;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		addProp(
			doc,
			scene,
			buffer,
			`lamp_${i}`,
			[
				{ geom: cylinderGeom(0.07, 0.06, 2.4, 0), mat: lampPost },
				{ geom: sphereGeom(0.16, 2.5), mat: lampGlow },
			],
			x,
			z,
		);
		colliders.push({ type: 'cylinder', x, z, radius: 0.12, halfHeight: 1.2 });
	}
	return { colliders };
}

function buildCyberpunk(doc, scene, buffer) {
	const rng = makeRng(909);
	const colliders = [];
	const towerMat = makeMaterial(doc, 'CyberTower', { color: '#15131f', metal: 0.6, rough: 0.4 });
	const neonPink = makeMaterial(doc, 'CyberNeonPink', {
		color: '#ff2db8',
		emissive: '#ff2db8',
		rough: 0.3,
	});
	const neonCyan = makeMaterial(doc, 'CyberNeonCyan', {
		color: '#23e0ff',
		emissive: '#23e0ff',
		rough: 0.3,
	});
	const neonViolet = makeMaterial(doc, 'CyberNeonViolet', {
		color: '#9b5cff',
		emissive: '#9b5cff',
		rough: 0.3,
	});
	const barrierMat = makeMaterial(doc, 'CyberBarrier', {
		color: '#1c1c26',
		metal: 0.5,
		rough: 0.5,
	});
	const NEONS = [neonPink, neonCyan, neonViolet];

	// Skyline of neon-trimmed towers around the perimeter.
	const TOWERS = 18;
	for (let i = 0; i < TOWERS; i++) {
		const angle = (i / TOWERS) * Math.PI * 2 + rng() * 0.12;
		const r = 8 + rng() * 3.5;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const w = 1.0 + rng() * 1.3;
		const d = 1.0 + rng() * 1.3;
		const h = 2.5 + rng() * 5.5;
		const rotY = rng() * Math.PI;
		const neon = NEONS[i % NEONS.length];
		addProp(
			doc,
			scene,
			buffer,
			`tower_${i}`,
			[
				{ geom: boxGeom(w, h, d, 0), mat: towerMat },
				{ geom: boxGeom(w * 1.02, 0.12, d * 1.02, h * 0.62), mat: neon },
				{ geom: boxGeom(w * 1.02, 0.12, d * 1.02, h * 0.86), mat: neon },
			],
			x,
			z,
			rotY,
		);
		colliders.push({ type: 'box', x, z, hx: w / 2, hy: h / 2, hz: d / 2, rotationY: rotY });
	}

	// Holographic signboards on poles near the centre.
	for (let i = 0; i < 5; i++) {
		const angle = (i / 5) * Math.PI * 2 + 0.5;
		const r = 4.2 + rng() * 1.4;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const neon = NEONS[(i + 1) % NEONS.length];
		addProp(
			doc,
			scene,
			buffer,
			`sign_${i}`,
			[
				{ geom: cylinderGeom(0.08, 0.08, 2.0, 0), mat: barrierMat },
				{ geom: boxGeom(1.1, 0.7, 0.06, 2.0), mat: neon },
			],
			x,
			z,
			angle + Math.PI / 2,
		);
		colliders.push({ type: 'cylinder', x, z, radius: 0.14, halfHeight: 1.0 });
	}

	// Low street barriers ringing the dance-able centre.
	for (let i = 0; i < 6; i++) {
		const angle = (i / 6) * Math.PI * 2;
		const r = 2.8;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const neon = NEONS[i % NEONS.length];
		addProp(
			doc,
			scene,
			buffer,
			`barrier_${i}`,
			[
				{ geom: boxGeom(1.3, 0.5, 0.22, 0), mat: barrierMat },
				{ geom: boxGeom(1.34, 0.06, 0.24, 0.5), mat: neon },
			],
			x,
			z,
			angle + Math.PI / 2,
		);
		colliders.push({
			type: 'box',
			x,
			z,
			hx: 0.65,
			hy: 0.25,
			hz: 0.11,
			rotationY: angle + Math.PI / 2,
		});
	}
	return { colliders };
}

function buildBeach(doc, scene, buffer) {
	const rng = makeRng(333);
	const colliders = [];
	const trunkMat = makeMaterial(doc, 'BeachTrunk', { color: '#8b6914', rough: 0.9 });
	const frondMat = makeMaterial(doc, 'BeachFrond', { color: '#2f9e44', rough: 0.8 });
	const coconutMat = makeMaterial(doc, 'BeachCoconut', { color: '#5c3a1e', rough: 0.85 });
	const waterMat = makeMaterial(doc, 'BeachWater', {
		color: '#1aa3d8',
		metal: 0.1,
		rough: 0.15,
		opacity: 0.72,
	});
	const foamMat = makeMaterial(doc, 'BeachFoam', { color: '#cdeefb', rough: 0.6, opacity: 0.85 });
	const umbrellaPole = makeMaterial(doc, 'BeachUmbrellaPole', {
		color: '#dddddd',
		metal: 0.3,
		rough: 0.6,
	});
	const umbrellaTop = makeMaterial(doc, 'BeachUmbrellaTop', { color: '#ef476f', rough: 0.7 });
	const rockMat = makeMaterial(doc, 'BeachRock', { color: '#8a8276', rough: 0.95 });

	// The sea — a translucent plane across the far side, with a foam line.
	addProp(
		doc,
		scene,
		buffer,
		'sea',
		[{ geom: boxGeom(40, 0.04, 16, 0.01), mat: waterMat }],
		0,
		-12,
	);
	addProp(
		doc,
		scene,
		buffer,
		'sea_foam',
		[{ geom: boxGeom(40, 0.05, 1.2, 0.02), mat: foamMat }],
		0,
		-4.4,
	);

	// Palm trees along the dunes (back half of the disc).
	const PALMS = 8;
	for (let i = 0; i < PALMS; i++) {
		const angle = (i / PALMS) * Math.PI + Math.PI * 0.5 + rng() * 0.3;
		const r = 5.5 + rng() * 4;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const lean = (rng() - 0.5) * 0.18;
		const frondParts = [];
		for (let f = 0; f < 6; f++) {
			const fa = (f / 6) * Math.PI * 2;
			frondParts.push({
				geom: rotZ(coneGeom(0.16, 1.5, 0), -1.15, fa, 2.5),
				mat: frondMat,
			});
		}
		addProp(
			doc,
			scene,
			buffer,
			`palm_${i}`,
			[
				{ geom: cylinderGeom(0.13, 0.08, 2.5, 0), mat: trunkMat },
				...frondParts,
				{ geom: sphereGeom(0.12, 2.45), mat: coconutMat },
			],
			x,
			z,
			lean,
		);
		colliders.push({ type: 'cylinder', x, z, radius: 0.26, halfHeight: 1.25 });
	}

	// Beach umbrellas + towels near spawn.
	for (const [ui, ux, uz] of [
		[0, -2.2, 2.0],
		[1, 2.6, 1.2],
	]) {
		addProp(
			doc,
			scene,
			buffer,
			`umbrella_${ui}`,
			[
				{ geom: cylinderGeom(0.04, 0.04, 2.0, 0), mat: umbrellaPole },
				{ geom: coneGeom(1.1, 0.5, 1.7), mat: umbrellaTop },
			],
			ux,
			uz,
		);
		colliders.push({ type: 'cylinder', x: ux, z: uz, radius: 0.1, halfHeight: 1.0 });
	}

	// A couple of rocks.
	for (let i = 0; i < 4; i++) {
		const angle = rng() * Math.PI * 2;
		const r = 4 + rng() * 4;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const s = 0.4 + rng() * 0.35;
		addProp(
			doc,
			scene,
			buffer,
			`rock_${i}`,
			[{ geom: sphereGeom(s, s * 0.6), mat: rockMat }],
			x,
			z,
		);
		colliders.push({ type: 'cylinder', x, z, radius: s * 0.85, halfHeight: s * 0.6 });
	}
	return { colliders };
}

// Rotate a geom about Z by `rz`, then about Y by `ry`, then translate up by
// `ty` — used to splay palm fronds out of the trunk top.
function rotZ(geom, rz, ry, ty) {
	const cz = Math.cos(rz);
	const sz = Math.sin(rz);
	const cy = Math.cos(ry);
	const sy = Math.sin(ry);
	const pos = geom.positions;
	const nrm = geom.normals;
	const out = new Float32Array(pos.length);
	const non = new Float32Array(nrm.length);
	for (let i = 0; i < pos.length; i += 3) {
		// Z-rotation.
		let x = pos[i] * cz - pos[i + 1] * sz;
		let y = pos[i] * sz + pos[i + 1] * cz;
		let z = pos[i + 2];
		y += ty;
		// Y-rotation.
		const x2 = x * cy + z * sy;
		const z2 = -x * sy + z * cy;
		out[i] = x2;
		out[i + 1] = y;
		out[i + 2] = z2;
		let nx = nrm[i] * cz - nrm[i + 1] * sz;
		let nyy = nrm[i] * sz + nrm[i + 1] * cz;
		let nz = nrm[i + 2];
		non[i] = nx * cy + nz * sy;
		non[i + 1] = nyy;
		non[i + 2] = -nx * sy + nz * cy;
	}
	return { positions: out, normals: non, indices: geom.indices };
}

function buildGallery(doc, scene, buffer) {
	const colliders = [];
	const wallMat = makeMaterial(doc, 'GalleryWall', { color: '#f3f1ec', rough: 0.92 });
	const trimMat = makeMaterial(doc, 'GalleryTrim', { color: '#d9d4c8', rough: 0.8 });
	const pedestalMat = makeMaterial(doc, 'GalleryPedestal', { color: '#e8e6e0', rough: 0.7 });
	const ART = ['#e63946', '#457b9d', '#f4a261', '#2a9d8f', '#6d597a', '#ffb703'];
	const sculptMat = makeMaterial(doc, 'GallerySculpture', {
		color: '#c0c0c8',
		metal: 0.7,
		rough: 0.35,
	});

	// Perimeter of tall white wall panels with hung artwork. A ring of flat
	// panels reads as a room without a continuous (terrain-clipping) shell.
	const PANELS = 12;
	const ringR = 8.5;
	for (let i = 0; i < PANELS; i++) {
		const angle = (i / PANELS) * Math.PI * 2;
		const x = Math.cos(angle) * ringR;
		const z = Math.sin(angle) * ringR;
		const facing = angle + Math.PI; // face the centre
		const artHex = ART[i % ART.length];
		const artMat = makeMaterial(doc, `GalleryArt_${i}`, {
			color: artHex,
			emissive: artHex,
			rough: 0.6,
		});
		addProp(
			doc,
			scene,
			buffer,
			`wall_${i}`,
			[
				{ geom: boxGeom(2.8, 3.4, 0.18, 0), mat: wallMat },
				{ geom: boxGeom(2.8, 0.12, 0.22, 3.3), mat: trimMat },
				{ geom: translateZ(boxGeom(1.5, 1.1, 0.05, 1.4), -0.12), mat: artMat },
			],
			x,
			z,
			facing,
		);
		colliders.push({ type: 'box', x, z, hx: 1.4, hy: 1.7, hz: 0.1, rotationY: facing });
	}

	// Sculpture pedestals around the floor.
	const PEDS = 6;
	for (let i = 0; i < PEDS; i++) {
		const angle = (i / PEDS) * Math.PI * 2 + Math.PI / PEDS;
		const r = 3.6;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const sculpt = i % 2 === 0 ? sphereGeom(0.34, 1.45) : boxGeom(0.5, 0.6, 0.5, 1.1);
		addProp(
			doc,
			scene,
			buffer,
			`pedestal_${i}`,
			[
				{ geom: cylinderGeom(0.34, 0.3, 1.1, 0), mat: pedestalMat },
				{ geom: sculpt, mat: sculptMat },
			],
			x,
			z,
		);
		colliders.push({ type: 'cylinder', x, z, radius: 0.36, halfHeight: 0.85 });
	}
	return { colliders };
}

// Translate a geom along local Z (used to inset gallery artwork into its wall).
function translateZ(geom, dz) {
	const out = new Float32Array(geom.positions);
	for (let i = 2; i < out.length; i += 3) out[i] += dz;
	return { positions: out, normals: geom.normals, indices: geom.indices };
}

// Translate a geom along local X (used for bench legs, desk legs).
function translateX(geom, dx) {
	const out = new Float32Array(geom.positions);
	for (let i = 0; i < out.length; i += 3) out[i] += dx;
	return { positions: out, normals: geom.normals, indices: geom.indices };
}

function buildOffice(doc, scene, buffer) {
	const rng = makeRng(42);
	const colliders = [];
	const deskMat = makeMaterial(doc, 'OfficeDesk', { color: '#3a3f4b', metal: 0.2, rough: 0.6 });
	const deskTop = makeMaterial(doc, 'OfficeDeskTop', { color: '#d7c9a8', rough: 0.55 });
	const chairMat = makeMaterial(doc, 'OfficeChair', { color: '#222831', rough: 0.7 });
	const plantPot = makeMaterial(doc, 'OfficePot', { color: '#b08968', rough: 0.8 });
	const plantLeaf = makeMaterial(doc, 'OfficeLeaf', { color: '#2f9e44', rough: 0.7 });
	const wallMat = makeMaterial(doc, 'OfficeWall', { color: '#20232b', metal: 0.2, rough: 0.6 });
	const brandMat = makeMaterial(doc, 'OfficeBrand', {
		color: '#7c5cff',
		emissive: '#7c5cff',
		rough: 0.4,
	});
	const screenMat = makeMaterial(doc, 'OfficeScreen', {
		color: '#0d1b2a',
		emissive: '#16324f',
		rough: 0.3,
	});

	// Reception / brand wall behind spawn.
	addProp(
		doc,
		scene,
		buffer,
		'brand_wall',
		[
			{ geom: boxGeom(6.5, 3.2, 0.2, 0), mat: wallMat },
			{ geom: boxGeom(2.4, 0.5, 0.08, 2.1), mat: brandMat },
		],
		0,
		-7.5,
	);

	// Desk clusters around the room.
	const DESKS = 6;
	for (let i = 0; i < DESKS; i++) {
		const angle = (i / DESKS) * Math.PI * 2 + 0.4;
		const r = 4.2 + rng() * 1.2;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const rotY = angle + Math.PI / 2;
		addProp(
			doc,
			scene,
			buffer,
			`desk_${i}`,
			[
				{ geom: boxGeom(1.6, 0.06, 0.8, 0.72), mat: deskTop },
				{ geom: translateX(boxGeom(0.1, 0.72, 0.7, 0), -0.72), mat: deskMat },
				{ geom: translateX(boxGeom(0.1, 0.72, 0.7, 0), 0.72), mat: deskMat },
				{ geom: translateZ(boxGeom(0.9, 0.55, 0.06, 0.78), -0.32), mat: screenMat },
			],
			x,
			z,
			rotY,
		);
		// Chair tucked in front of the desk.
		const cx = x - Math.cos(angle) * 0.9;
		const cz = z - Math.sin(angle) * 0.9;
		addProp(
			doc,
			scene,
			buffer,
			`chair_${i}`,
			[
				{ geom: boxGeom(0.5, 0.08, 0.5, 0.48), mat: chairMat },
				{ geom: boxGeom(0.5, 0.55, 0.07, 0.5), mat: chairMat },
			],
			cx,
			cz,
			rotY,
		);
		colliders.push({ type: 'box', x, z, hx: 0.8, hy: 0.4, hz: 0.4, rotationY: rotY });
	}

	// Potted plants in the corners.
	for (let i = 0; i < 4; i++) {
		const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
		const r = 6.4;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		addProp(
			doc,
			scene,
			buffer,
			`plant_${i}`,
			[
				{ geom: cylinderGeom(0.26, 0.3, 0.5, 0), mat: plantPot },
				{ geom: coneGeom(0.5, 1.2, 0.5), mat: plantLeaf },
				{ geom: coneGeom(0.36, 0.9, 1.0), mat: plantLeaf },
			],
			x,
			z,
		);
		colliders.push({ type: 'cylinder', x, z, radius: 0.3, halfHeight: 0.25 });
	}

	// Central meeting table.
	addProp(
		doc,
		scene,
		buffer,
		'meeting_table',
		[
			{ geom: cylinderGeom(1.3, 1.3, 0.06, 0.74), mat: deskTop },
			{ geom: cylinderGeom(0.2, 0.16, 0.74, 0), mat: deskMat },
		],
		0,
		2.6,
	);
	colliders.push({ type: 'cylinder', x: 0, z: 2.6, radius: 1.3, halfHeight: 0.4 });
	return { colliders };
}

// ═════════════════════════════════════════════════════════════════════════════
// HDR (equirectangular Radiance RGBE) — image-based lighting per environment.
// ═════════════════════════════════════════════════════════════════════════════

const HDR_W = 256;
const HDR_H = 128;

function packRGBE(r, g, b) {
	const v = Math.max(r, g, b);
	if (v < 1e-32) return [0, 0, 0, 0];
	let e = Math.ceil(Math.log2(v));
	let m = v / 2 ** e;
	if (m >= 1) {
		m *= 0.5;
		e += 1;
	}
	const scale = (m * 256) / v;
	return [
		Math.min(255, Math.max(0, Math.round(r * scale))),
		Math.min(255, Math.max(0, Math.round(g * scale))),
		Math.min(255, Math.max(0, Math.round(b * scale))),
		Math.min(255, Math.max(0, e + 128)),
	];
}

function bump(theta, phi, theta0, phi0, width) {
	const dT = Math.atan2(Math.sin(theta - theta0), Math.cos(theta - theta0));
	const dP = phi - phi0;
	return Math.exp(-(dT * dT + dP * dP) / (2 * width * width));
}

// A sky model parameterised per environment: a vertical gradient
// (zenith → horizon → ground) plus an optional sun disc and any number of
// coloured glow lobes (neon, lamps).
function makeSkySampler({ zenith, horizon, ground, sun = null, glows = [] }) {
	const zL = lin(zenith);
	const hL = lin(horizon);
	const gL = lin(ground);
	return (u, v) => {
		const theta = (u - 0.5) * Math.PI * 2;
		const phi = (0.5 - v) * Math.PI; // +π/2 zenith … -π/2 nadir
		const up = Math.sin(phi); // -1..1
		let r;
		let g;
		let b;
		if (up >= 0) {
			const t = up ** 0.6;
			r = hL[0] + (zL[0] - hL[0]) * t;
			g = hL[1] + (zL[1] - hL[1]) * t;
			b = hL[2] + (zL[2] - hL[2]) * t;
		} else {
			const t = (-up) ** 0.7;
			r = hL[0] + (gL[0] - hL[0]) * t;
			g = hL[1] + (gL[1] - hL[1]) * t;
			b = hL[2] + (gL[2] - hL[2]) * t;
		}
		if (sun) {
			const w = bump(theta, phi, sun.theta, sun.phi, sun.size);
			const [sr, sg, sb] = lin(sun.color);
			r += w * sr * sun.intensity;
			g += w * sg * sun.intensity;
			b += w * sb * sun.intensity;
		}
		for (const glow of glows) {
			const w = bump(theta, phi, glow.theta, glow.phi, glow.size);
			const [cr, cg, cb] = lin(glow.color);
			r += w * cr * glow.intensity;
			g += w * cg * glow.intensity;
			b += w * cb * glow.intensity;
		}
		return [r, g, b];
	};
}

function buildHdr(sampler) {
	const header =
		'#?RADIANCE\n# Authored by three.ws build-walk-environments (CC0 1.0)\n' +
		'FORMAT=32-bit_rle_rgbe\nEXPOSURE=1.0\n\n' +
		`-Y ${HDR_H} +X ${HDR_W}\n`;
	const headerBuf = Buffer.from(header, 'ascii');
	const px = Buffer.alloc(HDR_W * HDR_H * 4);
	for (let y = 0; y < HDR_H; y++) {
		for (let x = 0; x < HDR_W; x++) {
			const [r, g, b] = sampler((x + 0.5) / HDR_W, (y + 0.5) / HDR_H);
			const [R, G, B, E] = packRGBE(r, g, b);
			const idx = (y * HDR_W + x) * 4;
			px[idx] = R;
			px[idx + 1] = G;
			px[idx + 2] = B;
			px[idx + 3] = E;
		}
	}
	return Buffer.concat([headerBuf, px]);
}

// ═════════════════════════════════════════════════════════════════════════════
// Preview thumbnails — 256×256 JPEG composed from the env's sky gradient, a
// ground band, and themed SVG silhouettes. Real raster, visually distinct.
// ═════════════════════════════════════════════════════════════════════════════

function previewSvg({ skyTop, skyBottom, ground, silhouettes }) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="${skyBottom}"/>
  </linearGradient></defs>
  <rect width="256" height="256" fill="url(#sky)"/>
  <rect y="176" width="256" height="80" fill="${ground}"/>
  ${silhouettes}
</svg>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Environment table — single source feeding GLB, HDR, preview and manifest.
// ═════════════════════════════════════════════════════════════════════════════

const ENVS = [
	{
		name: 'park',
		label: 'Park',
		kind: 'outdoor',
		blurb: 'Rolling green with shade trees, benches, and lamp posts.',
		build: buildPark,
		terrain: { amplitude: 0.85, color: '#2f6b2c', seed: 4011 },
		sky: { top: '#3f87c8', bottom: '#bfe3f5' },
		light: {
			ambient: { color: '#fff7e6', intensity: 0.5 },
			hemi: { sky: '#a8d8ea', ground: '#3a5a28', intensity: 0.75 },
			sun: { color: '#fff2d2', intensity: 1.7, direction: [5, 9, 6] },
		},
		envIntensity: 0.85,
		dynamicProps: { balls: 3, crates: 2 },
		hdr: makeSkySampler({
			zenith: '#2f6fb0',
			horizon: '#bfe3f5',
			ground: '#3a5a28',
			sun: { theta: 0.7, phi: 0.9, color: '#fff4d6', intensity: 5.5, size: 0.18 },
		}),
		preview: {
			skyTop: '#3f87c8',
			skyBottom: '#bfe3f5',
			ground: '#2f6b2c',
			silhouettes: `
        <circle cx="200" cy="56" r="26" fill="#fff3c4" opacity="0.9"/>
        <g fill="#234d20"><ellipse cx="70" cy="150" rx="34" ry="40"/><rect x="64" y="170" width="12" height="36"/></g>
        <g fill="#2c5e28"><ellipse cx="150" cy="162" rx="26" ry="30"/><rect x="145" y="178" width="10" height="30"/></g>
        <rect x="96" y="196" width="60" height="10" rx="3" fill="#6b4423"/>`,
		},
	},
	{
		name: 'cyberpunk',
		label: 'Cyberpunk',
		kind: 'night',
		blurb: 'Neon-trimmed towers and holo signs over a rain-dark street.',
		build: buildCyberpunk,
		terrain: { amplitude: 0.06, color: '#0e0d14', seed: 5120 },
		sky: { top: '#0a0612', bottom: '#2a1140' },
		light: {
			ambient: { color: '#6a4fd0', intensity: 0.35 },
			hemi: { sky: '#3a2a6a', ground: '#1a0f2a', intensity: 0.5 },
			sun: { color: '#ff5ad0', intensity: 0.7, direction: [-4, 6, -3] },
		},
		envIntensity: 1.1,
		dynamicProps: { balls: 3, crates: 3 },
		hdr: makeSkySampler({
			zenith: '#0a0612',
			horizon: '#2a1140',
			ground: '#0e0d14',
			glows: [
				{ theta: -1.0, phi: 0.25, color: '#ff2db8', intensity: 3.2, size: 0.4 },
				{ theta: 0.6, phi: 0.2, color: '#23e0ff', intensity: 3.0, size: 0.4 },
				{ theta: 2.2, phi: 0.3, color: '#9b5cff', intensity: 2.6, size: 0.45 },
				{ theta: Math.PI, phi: -0.1, color: '#ff2db8', intensity: 1.6, size: 0.6 },
			],
		}),
		preview: {
			skyTop: '#0a0612',
			skyBottom: '#2a1140',
			ground: '#0e0d14',
			silhouettes: `
        <g>
          <rect x="40" y="70" width="34" height="120" fill="#15131f"/><rect x="40" y="110" width="34" height="4" fill="#ff2db8"/><rect x="40" y="150" width="34" height="4" fill="#ff2db8"/>
          <rect x="96" y="44" width="40" height="146" fill="#15131f"/><rect x="96" y="92" width="40" height="4" fill="#23e0ff"/><rect x="96" y="140" width="40" height="4" fill="#23e0ff"/>
          <rect x="156" y="80" width="30" height="110" fill="#15131f"/><rect x="156" y="120" width="30" height="4" fill="#9b5cff"/>
          <rect x="196" y="58" width="34" height="132" fill="#15131f"/><rect x="196" y="100" width="34" height="4" fill="#23e0ff"/>
        </g>`,
		},
	},
	{
		name: 'beach',
		label: 'Beach',
		kind: 'outdoor',
		blurb: 'Bright sand, palm trees, parasols, and a turquoise sea.',
		build: buildBeach,
		terrain: { amplitude: 0.5, color: '#d8c79a', seed: 2208 },
		sky: { top: '#2f7dd8', bottom: '#bfe9f7' },
		light: {
			ambient: { color: '#fff8e7', intensity: 0.65 },
			hemi: { sky: '#cfe9ff', ground: '#c2b280', intensity: 0.8 },
			sun: { color: '#fff0c4', intensity: 1.9, direction: [6, 8, 4] },
		},
		envIntensity: 1.0,
		dynamicProps: { balls: 5, crates: 0 },
		hdr: makeSkySampler({
			zenith: '#2f7dd8',
			horizon: '#bfe9f7',
			ground: '#d8c79a',
			sun: { theta: 0.5, phi: 0.55, color: '#fff4d0', intensity: 6.5, size: 0.16 },
		}),
		preview: {
			skyTop: '#2f7dd8',
			skyBottom: '#bfe9f7',
			ground: '#d8c79a',
			silhouettes: `
        <circle cx="58" cy="58" r="28" fill="#fff4d0" opacity="0.95"/>
        <rect y="150" width="256" height="30" fill="#1aa3d8" opacity="0.85"/>
        <g stroke="#8b6914" stroke-width="7" fill="none"><path d="M188 196 Q196 150 198 120"/></g>
        <g fill="#2f9e44"><ellipse cx="198" cy="116" rx="30" ry="10"/><ellipse cx="198" cy="116" rx="10" ry="26"/><ellipse cx="180" cy="124" rx="22" ry="9" transform="rotate(-28 180 124)"/><ellipse cx="216" cy="124" rx="22" ry="9" transform="rotate(28 216 124)"/></g>`,
		},
	},
	{
		name: 'gallery',
		label: 'Gallery',
		kind: 'indoor',
		blurb: 'White-walled exhibition space — pedestals and hung artwork.',
		build: buildGallery,
		terrain: { amplitude: 0.0, color: '#e9e6df', seed: 100 },
		sky: { top: '#f7f6f3', bottom: '#d9d6cf' },
		light: {
			ambient: { color: '#ffffff', intensity: 0.85 },
			hemi: { sky: '#ffffff', ground: '#d9d6cf', intensity: 0.9 },
			sun: { color: '#ffffff', intensity: 1.1, direction: [3, 10, 5] },
		},
		envIntensity: 1.15,
		dynamicProps: { balls: 2, crates: 0 },
		hdr: makeSkySampler({
			zenith: '#ffffff',
			horizon: '#eceae4',
			ground: '#d4d1ca',
			glows: [
				{ theta: 0, phi: 1.2, color: '#ffffff', intensity: 2.4, size: 0.7 },
				{ theta: Math.PI, phi: 1.2, color: '#ffffff', intensity: 2.0, size: 0.7 },
			],
		}),
		preview: {
			skyTop: '#f7f6f3',
			skyBottom: '#eceae4',
			ground: '#e9e6df',
			silhouettes: `
        <rect x="20" y="40" width="216" height="120" fill="#fbfaf7"/>
        <rect x="44" y="66" width="46" height="58" fill="#e63946"/>
        <rect x="106" y="66" width="46" height="58" fill="#457b9d"/>
        <rect x="168" y="66" width="46" height="58" fill="#2a9d8f"/>
        <rect x="112" y="176" width="32" height="44" fill="#e8e6e0"/>
        <circle cx="128" cy="168" r="14" fill="#c0c0c8"/>`,
		},
	},
	{
		name: 'void',
		label: 'Void',
		kind: 'abstract',
		blurb: 'A minimal grid plane under a soft gradient — pure focus.',
		build: null, // procedural grid in src/walk-environments.js, no GLB
		terrain: { amplitude: 0.0, color: '#0c0e16', seed: 7 },
		sky: { top: '#10131f', bottom: '#1b2740' },
		light: {
			ambient: { color: '#8aa0d8', intensity: 0.45 },
			hemi: { sky: '#26406e', ground: '#0a0c14', intensity: 0.55 },
			sun: { color: '#aab8ff', intensity: 0.9, direction: [2, 8, 4] },
		},
		envIntensity: 0.5,
		dynamicProps: { balls: 3, crates: 0 },
		grid: { color: '#3a5e9e', accent: '#6ea8ff', size: 24, divisions: 24 },
		hdr: null, // flat dark IBL applied at runtime
		preview: {
			skyTop: '#10131f',
			skyBottom: '#1b2740',
			ground: '#0c0e16',
			silhouettes: `
        <g stroke="#3a5e9e" stroke-width="1.4" opacity="0.9">
          <path d="M0 200 L256 200"/><path d="M0 224 L256 224"/>
          <path d="M30 176 L-40 256"/><path d="M226 176 L296 256"/>
          <path d="M86 176 L60 256"/><path d="M170 176 L196 256"/>
          <path d="M128 176 L128 256"/>
        </g>
        <circle cx="128" cy="120" r="46" fill="none" stroke="#6ea8ff" stroke-width="2" opacity="0.6"/>`,
		},
	},
	{
		name: 'office',
		label: 'Office',
		kind: 'indoor',
		blurb: 'The three.ws virtual office — desks, plants, and a brand wall.',
		build: buildOffice,
		terrain: { amplitude: 0.0, color: '#2b2f3a', seed: 808 },
		sky: { top: '#aab4c8', bottom: '#7e8aa0' },
		light: {
			ambient: { color: '#eaf0ff', intensity: 0.7 },
			hemi: { sky: '#cdd8ee', ground: '#2b2f3a', intensity: 0.7 },
			sun: { color: '#fbfdff', intensity: 1.2, direction: [4, 9, 5] },
		},
		envIntensity: 0.95,
		dynamicProps: { balls: 2, crates: 2 },
		hdr: makeSkySampler({
			zenith: '#c2ccde',
			horizon: '#9aa6bc',
			ground: '#2b2f3a',
			glows: [
				{ theta: 0.4, phi: 1.0, color: '#ffffff', intensity: 1.8, size: 0.6 },
				{ theta: -1.6, phi: 1.0, color: '#dfe8ff', intensity: 1.5, size: 0.6 },
			],
		}),
		preview: {
			skyTop: '#aab4c8',
			skyBottom: '#7e8aa0',
			ground: '#2b2f3a',
			silhouettes: `
        <rect x="20" y="44" width="216" height="96" fill="#20232b"/>
        <rect x="96" y="74" width="64" height="14" rx="3" fill="#7c5cff"/>
        <rect x="50" y="168" width="60" height="10" fill="#d7c9a8"/><rect x="58" y="178" width="44" height="34" fill="#3a3f4b"/>
        <rect x="146" y="168" width="60" height="10" fill="#d7c9a8"/><rect x="154" y="178" width="44" height="34" fill="#3a3f4b"/>
        <g fill="#2f9e44"><polygon points="222,210 210,168 234,168"/></g>
        <rect x="216" y="208" width="12" height="10" fill="#b08968"/>`,
		},
	},
];

// ─── Build one environment ───────────────────────────────────────────────────

async function buildEnv(env, io) {
	const dir = resolve(OUT_DIR, env.name);
	mkdirSync(dir, { recursive: true });

	let colliders = [];
	if (env.build) {
		const doc = new Document();
		doc.createBuffer();
		const buffer = doc.getRoot().listBuffers()[0];
		const scene = doc.createScene(`${env.label}Scene`);
		const res = env.build(doc, scene, buffer);
		colliders = res.colliders || [];
		const bytes = await io.writeBinary(doc);
		writeFileSync(resolve(dir, 'scene.glb'), Buffer.from(bytes));
	}

	let hasHdr = false;
	if (env.hdr) {
		writeFileSync(resolve(dir, 'env.hdr'), buildHdr(env.hdr));
		hasHdr = true;
	}

	await sharp(Buffer.from(previewSvg(env.preview)))
		.jpeg({ quality: 86 })
		.toFile(resolve(dir, 'preview.jpg'));

	return {
		name: env.name,
		label: env.label,
		kind: env.kind,
		blurb: env.blurb,
		scene: env.build ? `${env.name}/scene.glb` : null,
		hdr: hasHdr ? `${env.name}/env.hdr` : null,
		preview: `${env.name}/preview.jpg`,
		terrain: env.terrain,
		sky: env.sky,
		light: env.light,
		envIntensity: env.envIntensity,
		grid: env.grid || null,
		dynamicProps: env.dynamicProps,
		colliders: colliders.map(roundCollider),
	};
}

function roundCollider(c) {
	const r = (n) => Math.round(n * 1000) / 1000;
	const out = { type: c.type, x: r(c.x), z: r(c.z) };
	if (c.type === 'cylinder') {
		out.radius = r(c.radius);
		out.halfHeight = r(c.halfHeight);
	} else {
		out.hx = r(c.hx);
		out.hy = r(c.hy);
		out.hz = r(c.hz);
		if (c.rotationY) out.rotationY = r(c.rotationY);
	}
	return out;
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const io = new NodeIO();
	const manifest = { version: 1, default: 'park', environments: [] };
	for (const env of ENVS) {
		const entry = await buildEnv(env, io);
		manifest.environments.push(entry);
		const parts = [
			entry.scene ? 'glb' : 'procedural',
			entry.hdr ? 'hdr' : 'no-hdr',
			`${entry.colliders.length} colliders`,
		];
		console.log(`[walk-env] ${env.name.padEnd(10)} ${parts.join(', ')}`);
	}
	writeFileSync(resolve(OUT_DIR, 'index.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
	console.log(`[walk-env] wrote index.json (${manifest.environments.length} environments)`);
}

main().catch((err) => {
	console.error('[walk-env] build failed:', err);
	process.exit(1);
});

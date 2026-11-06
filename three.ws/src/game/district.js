// District — the drivable open-world block grid that turns the bare plaza into a
// coherent little city (W01: open-world foundation).
//
// The original Downtown plaza (the centre circle the totem, market screens and
// ponds live on) is kept clear; everything this module builds rings it: an
// asphalt street grid, raised sidewalk blocks, building shells, streetlights and
// planters, out to the district bounds. It's themeable per coin — colours are
// pulled from the same biome palette world-env.js uses — and deterministic from
// the coin's seed, so every client renders the IDENTICAL city (a requirement for
// two players to agree on where the walls are).
//
// Performance is built in: buildings, sidewalks, streetlights and planters are
// each a single InstancedMesh (one draw call apiece), geometry is shared, and the
// whole grid is a few thousand triangles. The returned `colliders` feed the
// shared Rapier PhysicsWorld so the buildings are solid; `setNight()` lets the
// day/night cycle switch the windows and lamps on after dusk.

import {
	Group, Color, Object3D, Mesh,
	InstancedMesh, BoxGeometry, CylinderGeometry, IcosahedronGeometry,
	MeshStandardMaterial, MeshBasicMaterial,
	Shape, Path, ShapeGeometry,
	CanvasTexture, RepeatWrapping, SRGBColorSpace,
} from 'three';

import { DISTRICT } from './world-zones.js';

// Deterministic LCG — identical seed → identical city on every client.
function rng(seed) {
	let s = (seed >>> 0) || 0x9e3779b9;
	return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}

// A tiled facade: a dark wall with a grid of window cells, some lit. Used as both
// the diffuse `map` (a believable building skin by day) and the `emissiveMap`
// (only the bright window cells glow when the night intensity is raised), so a
// whole skyline lights up at dusk for the cost of one shared texture.
function facadeTexture(rand) {
	const c = document.createElement('canvas');
	c.width = 128; c.height = 128;
	const x = c.getContext('2d');
	x.fillStyle = '#23272f'; x.fillRect(0, 0, 128, 128);
	const cols = 4, rows = 4, pad = 6, gap = 6;
	const cw = (128 - pad * 2 - gap * (cols - 1)) / cols;
	const ch = (128 - pad * 2 - gap * (rows - 1)) / rows;
	for (let r = 0; r < rows; r++) {
		for (let col = 0; col < cols; col++) {
			// Window cells: mostly pale glass, ~1 in 4 dark (lights off / blind).
			x.fillStyle = rand() > 0.25 ? '#cdd8e6' : '#3a3f49';
			x.fillRect(pad + col * (cw + gap), pad + r * (ch + gap), cw, ch);
		}
	}
	const tex = new CanvasTexture(c);
	tex.colorSpace = SRGBColorSpace;
	tex.wrapS = tex.wrapT = RepeatWrapping;
	tex.repeat.set(2, 3);
	return tex;
}

/**
 * Build the district into `scene`.
 * @param {import('three').Scene} scene
 * @param {{ seed?: number, biome?: object, playRadius?: number }} opts
 * @returns {{ root: Group, colliders: Array, setNight(k:number):void, dispose():void }}
 */
export function createDistrict(scene, { seed = 0, biome = {}, playRadius = DISTRICT.plazaRadius } = {}) {
	const root = new Group();
	root.name = 'district';
	scene.add(root);

	const rand = rng(seed);
	const { half, blockSize, roadWidth } = DISTRICT;
	const pitch = blockSize + roadWidth;
	// Keep the grid clear of Downtown and its ring boulevard; a frontier town also
	// rings the plaza, so leave it more room when the biome flags one.
	const clearR = Math.max(playRadius + roadWidth + 6, biome.town ? 98 : playRadius + 14);
	const colliders = [];

	// --- Asphalt: a square slab with Downtown punched out so the plaza shows ----
	const outer = new Shape();
	outer.moveTo(-half, -half); outer.lineTo(half, -half);
	outer.lineTo(half, half); outer.lineTo(-half, half); outer.lineTo(-half, -half);
	const hole = new Path();
	hole.absarc(0, 0, playRadius, 0, Math.PI * 2, true);
	outer.holes.push(hole);
	const asphalt = new Mesh(
		new ShapeGeometry(outer),
		new MeshStandardMaterial({ color: new Color(biome.grid || 0x2a2e36).multiplyScalar(0.5), roughness: 0.95, metalness: 0 }),
	);
	asphalt.rotation.x = -Math.PI / 2; asphalt.position.y = 0.006; asphalt.receiveShadow = true;
	root.add(asphalt);

	// --- Lane markings on the two main cross avenues ----------------------------
	const laneMat = new MeshBasicMaterial({ color: 0xe8e2c8, transparent: true, opacity: 0.55 });
	const laneGeo = new BoxGeometry(2.2, 0.02, 0.5);
	const dashCount = Math.floor((half - playRadius) / 6);
	const lanes = new InstancedMesh(laneGeo, laneMat, dashCount * 4);
	{
		const o = new Object3D();
		let i = 0;
		for (const axis of ['x', 'z']) {
			for (const sign of [-1, 1]) {
				for (let d = 0; d < dashCount; d++) {
					const along = playRadius + 4 + d * 6;
					if (axis === 'x') o.position.set(sign * along, 0.02, 0);
					else { o.position.set(0, 0.02, sign * along); o.rotation.set(0, Math.PI / 2, 0); }
					o.updateMatrix(); lanes.setMatrixAt(i++, o.matrix); o.rotation.set(0, 0, 0);
				}
			}
		}
		lanes.count = i;
	}
	root.add(lanes);

	// --- Collect the block layout ----------------------------------------------
	// Walk the grid; every cell whose centre clears Downtown and fits the bounds
	// becomes a block: a raised sidewalk slab carrying 1–3 building shells.
	const reach = Math.floor((half - blockSize / 2) / pitch);
	const slabs = [];     // { x, z }
	const buildings = []; // { x, z, w, d, h, tint }
	// Building palette tinted from the biome so each coin's city reads differently.
	const tints = [
		new Color(biome.plaza || 0x9aa0aa),
		new Color(biome.hill || 0x8a909a).lerp(new Color(0x9aa6b6), 0.4),
		new Color(biome.ground || 0x808890).lerp(new Color(0xb8c2d0), 0.5),
		new Color(biome.ring || 0x6f8fbf).lerp(new Color(0xffffff), 0.35), // glass accent
	];
	for (let gx = -reach; gx <= reach; gx++) {
		for (let gz = -reach; gz <= reach; gz++) {
			const cx = gx * pitch, cz = gz * pitch;
			if (Math.hypot(cx, cz) < clearR) continue;          // Downtown + boulevard
			if (Math.max(Math.abs(cx), Math.abs(cz)) > half - blockSize / 2) continue; // bounds
			slabs.push({ x: cx, z: cz });

			// Taller toward the centre (a real skyline), shorter out in the wilds.
			const distN = Math.min(1, Math.hypot(cx, cz) / half);
			const count = 1 + Math.floor(rand() * 3); // 1..3 shells per block
			const inset = 3.2; // sidewalk margin
			const cell = (blockSize - inset * 2) / Math.ceil(Math.sqrt(count));
			let placed = 0;
			for (let k = 0; k < count; k++) {
				const w = cell * (0.55 + rand() * 0.35);
				const d = cell * (0.55 + rand() * 0.35);
				const baseH = 8 + rand() * 16;
				const h = baseH * (1.6 - distN) + (rand() > 0.82 ? 18 * (1.2 - distN) : 0);
				// Offset within the block so shells don't all stack on the centre.
				const ox = (rand() - 0.5) * (blockSize - inset * 2 - w);
				const oz = (rand() - 0.5) * (blockSize - inset * 2 - d);
				const bx = cx + ox, bz = cz + oz;
				buildings.push({ x: bx, z: bz, w, d, h, tint: tints[Math.floor(rand() * tints.length)] });
				placed++;
			}
			void placed;
		}
	}

	// --- Sidewalk slabs (one draw call) -----------------------------------------
	const slabMat = new MeshStandardMaterial({ color: new Color(biome.plaza || 0xc9c2b2).lerp(new Color(0x9a9a9a), 0.3), roughness: 1, metalness: 0 });
	const slabGeo = new BoxGeometry(blockSize, 0.12, blockSize);
	const slabMesh = new InstancedMesh(slabGeo, slabMat, slabs.length);
	slabMesh.receiveShadow = true;
	{
		const o = new Object3D();
		slabs.forEach((s, i) => { o.position.set(s.x, 0.06, s.z); o.updateMatrix(); slabMesh.setMatrixAt(i, o.matrix); });
	}
	root.add(slabMesh);

	// --- Building shells (one draw call, per-instance tint + lit windows) -------
	const facade = facadeTexture(rand);
	const buildMat = new MeshStandardMaterial({
		map: facade, emissiveMap: facade, emissive: new Color(0xffd9a0),
		emissiveIntensity: 0, roughness: 0.82, metalness: 0.05,
	});
	const buildGeo = new BoxGeometry(1, 1, 1);
	const buildMesh = new InstancedMesh(buildGeo, buildMat, buildings.length);
	buildMesh.castShadow = true; buildMesh.receiveShadow = true;
	{
		const o = new Object3D();
		buildings.forEach((b, i) => {
			const cyl = 0.12 + b.h / 2; // sit on the sidewalk slab top
			o.position.set(b.x, cyl, b.z);
			o.scale.set(b.w, b.h, b.d);
			o.rotation.set(0, 0, 0);
			o.updateMatrix();
			buildMesh.setMatrixAt(i, o.matrix);
			buildMesh.setColorAt(i, b.tint);
			colliders.push({
				position: { x: b.x, y: cyl, z: b.z },
				halfExtents: { x: b.w / 2, y: b.h / 2, z: b.d / 2 },
				rotationY: 0,
			});
		});
	}
	if (buildMesh.instanceColor) buildMesh.instanceColor.needsUpdate = true;
	root.add(buildMesh);

	// --- Streetlights at the grid intersections (poles + glowing lamps) ---------
	const lights = [];
	for (let gx = -reach; gx <= reach; gx++) {
		for (let gz = -reach; gz <= reach; gz++) {
			const ix = gx * pitch + pitch / 2, iz = gz * pitch + pitch / 2;
			if (Math.hypot(ix, iz) < clearR) continue;
			if (Math.max(Math.abs(ix), Math.abs(iz)) > half - 2) continue;
			lights.push({ x: ix, z: iz });
		}
	}
	const poleMat = new MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.7, metalness: 0.4 });
	const poleGeo = new CylinderGeometry(0.12, 0.16, 5.2, 6);
	const poleMesh = new InstancedMesh(poleGeo, poleMat, lights.length);
	poleMesh.castShadow = true;
	const lampMat = new MeshBasicMaterial({ color: 0xffe6b0 });
	const lampGeo = new IcosahedronGeometry(0.28, 0);
	const lampMesh = new InstancedMesh(lampGeo, lampMat, lights.length);
	{
		const o = new Object3D();
		lights.forEach((p, i) => {
			o.position.set(p.x, 2.6, p.z); o.updateMatrix(); poleMesh.setMatrixAt(i, o.matrix);
			o.position.set(p.x, 5.3, p.z); o.updateMatrix(); lampMesh.setMatrixAt(i, o.matrix);
		});
	}
	root.add(poleMesh, lampMesh);

	// --- Planters dotted along the sidewalks (life + a touch of green) ----------
	const planterMat = new MeshStandardMaterial({ color: new Color(biome.leafA || 0x4f8a49), roughness: 1, metalness: 0, flatShading: true });
	const planterGeo = new IcosahedronGeometry(0.9, 0);
	const planterMesh = new InstancedMesh(planterGeo, planterMat, slabs.length);
	{
		const o = new Object3D();
		slabs.forEach((s, i) => {
			const a = rand() * Math.PI * 2, rr = blockSize / 2 - 1.5;
			o.position.set(s.x + Math.cos(a) * rr, 0.9, s.z + Math.sin(a) * rr);
			o.scale.setScalar(0.7 + rand() * 0.5);
			o.updateMatrix(); planterMesh.setMatrixAt(i, o.matrix); o.scale.setScalar(1);
		});
	}
	planterMesh.castShadow = true;
	root.add(planterMesh);

	// The lamp glow as a baseline so it reads even before the cycle runs.
	const baseLamp = 1;

	return {
		root,
		colliders,
		// Switch the city over to night. k = 0 (full day) … 1 (deep night): windows
		// and streetlamps come up as k rises. Called by the day/night cycle.
		setNight(k) {
			const n = Math.max(0, Math.min(1, k));
			buildMat.emissiveIntensity = n * 1.15;
			lampMat.color.setRGB(1, 0.9, 0.7).multiplyScalar(baseLamp * (0.35 + n * 0.65));
		},
		dispose() {
			scene.remove(root);
			facade.dispose();
			root.traverse((o) => {
				if (o.isMesh || o.isInstancedMesh) {
					o.geometry?.dispose?.();
					const ms = Array.isArray(o.material) ? o.material : [o.material];
					for (const m of ms) m?.dispose?.();
				}
			});
		},
	};
}

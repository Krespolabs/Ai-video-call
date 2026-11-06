/**
 * Mesh → Gaussian-splat conversion — three.ws's own splat-generation lane.
 *
 * Instead of renting a text-to-splat API, we own the format both ways: any mesh
 * the platform can produce (a Lab generator, a forged GLB, an uploaded model)
 * gets resampled into a Gaussian-splat radiance field entirely in the browser.
 *
 * Approach: area-weighted surface sampling. We walk every triangle, sample N
 * points proportional to triangle area, and read colour in priority order:
 *   1. the material's texture map, sampled at the point's interpolated UV
 *      (so a real textured GLB keeps its true colours, not a flat base tint);
 *   2. per-vertex colours (e.g. the terrain generator);
 *   3. the material base colour.
 * Each point becomes one Gaussian in the antimatter15 `.splat` layout
 * (32 bytes/splat: center f32×3, scale f32×3, colour u8×4, rotation u8×4).
 * Colours are emitted in sRGB so the radiance field matches the lit mesh.
 *
 * The sampler is async and yields between chunks so converting 100k+ splats
 * never freezes the tab, reporting progress as it goes.
 */

import * as THREE from 'three';

const TEX_MAX = 1024; // cap sampled-texture resolution for speed/memory

const _v = {
	a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(),
	ab: new THREE.Vector3(), ac: new THREE.Vector3(),
	p: new THREE.Vector3(),
	col: new THREE.Color(),
};

function collectMeshes(object3d) {
	const meshes = [];
	object3d.updateMatrixWorld(true);
	object3d.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o); });
	return meshes;
}

// Rasterize a material's base-colour texture to an ImageData once, so we can
// sample it per point. Returns null if the material has no drawable map.
function buildTextureSampler(material) {
	const map = material?.map;
	const img = map?.image;
	if (!img || !(img.width || img.naturalWidth)) return null;
	const iw = img.width || img.naturalWidth;
	const ih = img.height || img.naturalHeight;
	if (!iw || !ih) return null;
	const scale = Math.min(1, TEX_MAX / Math.max(iw, ih));
	const w = Math.max(1, Math.round(iw * scale));
	const h = Math.max(1, Math.round(ih * scale));
	let data;
	try {
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(img, 0, 0, w, h);
		data = ctx.getImageData(0, 0, w, h).data;
	} catch {
		return null; // tainted/undrawable image — fall back to vertex/material colour
	}
	const flipY = map.flipY !== false; // glTF textures are flipY:false; default true otherwise
	return (u, vv, out) => {
		// wrap UVs into [0,1)
		let uu = u - Math.floor(u);
		let v = vv - Math.floor(vv);
		const px = Math.min(w - 1, Math.max(0, Math.floor(uu * w)));
		const sampleV = flipY ? 1 - v : v;
		const py = Math.min(h - 1, Math.max(0, Math.floor(sampleV * h)));
		const idx = (py * w + px) * 4;
		out.set(data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255); // already sRGB bytes
		return true;
	};
}

// Build a flat triangle list with world positions, per-vertex colours, UVs and
// a per-triangle texture sampler.
function gatherTriangles(meshes) {
	const tris = [];
	for (const mesh of meshes) {
		const geo = mesh.geometry;
		const pos = geo.attributes.position;
		const colAttr = geo.attributes.color || null;
		const uvAttr = geo.attributes.uv || null;
		const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
		const matColorSRGB = new THREE.Color(1, 1, 1);
		if (m?.color) matColorSRGB.copy(m.color).convertLinearToSRGB();
		const texSampler = buildTextureSampler(m);
		const index = geo.index;
		const triCount = index ? index.count / 3 : pos.count / 3;
		for (let t = 0; t < triCount; t++) {
			const i0 = index ? index.getX(t * 3) : t * 3;
			const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
			const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
			const a = _v.a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld).clone();
			const b = _v.b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld).clone();
			const c = _v.c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld).clone();
			// Per-vertex colours are linear in three; convert to sRGB for emission.
			const ca = colAttr ? new THREE.Color().fromBufferAttribute(colAttr, i0).convertLinearToSRGB() : matColorSRGB;
			const cb = colAttr ? new THREE.Color().fromBufferAttribute(colAttr, i1).convertLinearToSRGB() : matColorSRGB;
			const cc = colAttr ? new THREE.Color().fromBufferAttribute(colAttr, i2).convertLinearToSRGB() : matColorSRGB;
			const uv = uvAttr && texSampler
				? [uvAttr.getX(i0), uvAttr.getY(i0), uvAttr.getX(i1), uvAttr.getY(i1), uvAttr.getX(i2), uvAttr.getY(i2)]
				: null;
			const area = _v.ab.subVectors(b, a).cross(_v.ac.subVectors(c, a)).length() * 0.5;
			tris.push({ a, b, c, ca, cb, cc, uv, texSampler: uv ? texSampler : null, area });
		}
	}
	return tris;
}

// Deterministic PRNG so the same model + seed always yields the same splat cloud.
function mulberry32(seed) {
	let s = seed >>> 0;
	return () => {
		s |= 0; s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Convert a THREE.Object3D into a `.splat` ArrayBuffer.
 * @param {THREE.Object3D} object3d
 * @param {{count?:number, seed?:number, scale?:number, onProgress?:(pct:number)=>void}} [opts]
 * @returns {Promise<{buffer: ArrayBuffer, count: number, textured: boolean}>}
 */
export async function meshToSplatBuffer(object3d, opts = {}) {
	const count = Math.max(500, Math.min(200000, Math.floor(opts.count ?? 30000)));
	const seed = Math.floor(opts.seed ?? 1);
	const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
	const meshes = collectMeshes(object3d);
	if (!meshes.length) throw new Error('No mesh geometry to convert.');
	const tris = gatherTriangles(meshes);
	if (!tris.length) throw new Error('No triangles found in the model.');
	const textured = tris.some((t) => t.texSampler);

	// Cumulative area table for weighted sampling.
	const cum = new Float64Array(tris.length);
	let total = 0;
	for (let i = 0; i < tris.length; i++) { total += tris[i].area; cum[i] = total; }
	if (total <= 0) throw new Error('Model has zero surface area.');

	// Splat scale ~ a fraction of the model's size so the shell reads as solid.
	const box = new THREE.Box3().setFromObject(object3d);
	const diag = box.getSize(new THREE.Vector3()).length() || 1;
	const splatScale = (opts.scale ?? 0.004) * diag;

	const rnd = mulberry32(seed);
	const buf = new ArrayBuffer(count * 32);
	const dv = new DataView(buf);

	const pickTri = (r) => {
		let lo = 0, hi = tris.length - 1;
		const target = r * total;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cum[mid] < target) lo = mid + 1; else hi = mid;
		}
		return tris[lo];
	};

	const CHUNK = 8192; // must be a power of 2 for the (i & (CHUNK-1)) bitmask
	for (let i = 0; i < count; i++) {
		const tri = pickTri(rnd());
		// Uniform barycentric sample.
		let u = rnd(), v = rnd();
		if (u + v > 1) { u = 1 - u; v = 1 - v; }
		const w = 1 - u - v;
		_v.p.set(0, 0, 0).addScaledVector(tri.a, w).addScaledVector(tri.b, u).addScaledVector(tri.c, v);

		if (tri.texSampler) {
			const tu = tri.uv[0] * w + tri.uv[2] * u + tri.uv[4] * v;
			const tv = tri.uv[1] * w + tri.uv[3] * u + tri.uv[5] * v;
			tri.texSampler(tu, tv, _v.col);
		} else {
			_v.col.setRGB(
				tri.ca.r * w + tri.cb.r * u + tri.cc.r * v,
				tri.ca.g * w + tri.cb.g * u + tri.cc.g * v,
				tri.ca.b * w + tri.cb.b * u + tri.cc.b * v,
			);
		}

		const base = i * 32;
		dv.setFloat32(base, _v.p.x, true);
		dv.setFloat32(base + 4, _v.p.y, true);
		dv.setFloat32(base + 8, _v.p.z, true);
		dv.setFloat32(base + 12, splatScale, true);
		dv.setFloat32(base + 16, splatScale, true);
		dv.setFloat32(base + 20, splatScale, true);
		dv.setUint8(base + 24, Math.round(THREE.MathUtils.clamp(_v.col.r, 0, 1) * 255));
		dv.setUint8(base + 25, Math.round(THREE.MathUtils.clamp(_v.col.g, 0, 1) * 255));
		dv.setUint8(base + 26, Math.round(THREE.MathUtils.clamp(_v.col.b, 0, 1) * 255));
		dv.setUint8(base + 27, 255);
		dv.setUint8(base + 28, 255); // identity rotation (w,x,y,z) → bytes
		dv.setUint8(base + 29, 128);
		dv.setUint8(base + 30, 128);
		dv.setUint8(base + 31, 128);

		if ((i & (CHUNK - 1)) === CHUNK - 1) {
			if (onProgress) onProgress(Math.round(((i + 1) / count) * 100));
			await nextTick();
		}
	}
	if (onProgress) onProgress(100);

	return { buffer: buf, count, textured };
}

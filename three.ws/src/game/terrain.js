// terrain.js — procedural heightfield terrain for the social walkaround.
//
// Single source of truth for ground shape: one height grid drives both the
// rendered Three.js mesh AND the Rapier heightfield collider, so the visible
// surface and the physics surface can never drift apart.
//
// The grid is a square of `size` world-units centred on the origin, sampled at
// (segments + 1) points per side. Heights are stored COLUMN-MAJOR in a single
// Float32Array — exactly the layout Rapier's `ColliderDesc.heightfield`
// expects — so physics-world.js can hand the array straight to Rapier with no
// copy or transpose. See heightIndex() for the row/col → world mapping.

import {
	BufferGeometry,
	BufferAttribute,
	Mesh,
	MeshStandardMaterial,
	Float32BufferAttribute,
} from 'three';

// Deterministic PRNG (LCG) so a given seed always yields the same terrain —
// important for multiplayer: every client must generate an identical surface.
function makePRNG(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

// Smooth value-noise on a 256×256 lattice. fBm sums several octaves for
// natural rolling hills without external noise dependencies.
function makeValueNoise(seed) {
	const rand = makePRNG(seed);
	const G = 256;
	const lattice = new Float32Array(G * G);
	for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
	const at = (xi, yi) => lattice[(xi & 255) + (yi & 255) * G];
	return (x, y) => {
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const fx = x - x0;
		const fy = y - y0;
		// Smoothstep weights kill the lattice-aligned creasing of linear interp.
		const sx = fx * fx * (3 - 2 * fx);
		const sy = fy * fy * (3 - 2 * fy);
		const v00 = at(x0, y0);
		const v10 = at(x0 + 1, y0);
		const v01 = at(x0, y0 + 1);
		const v11 = at(x0 + 1, y0 + 1);
		const a = v00 + (v10 - v00) * sx;
		const b = v01 + (v11 - v01) * sx;
		return a + (b - a) * sy; // 0..1
	};
}

const DEFAULTS = {
	size: 56, // world-units per side (square, centred on origin)
	segments: 120, // cells per side → (segments+1)² height samples
	seed: 1337,
	amplitude: 1.8, // peak height of the hills, metres
	frequency: 0.045, // noise frequency — lower = broader features
	octaves: 4,
	flatRadius: 4.0, // fully flat disc around spawn (metres)
	flatFalloff: 9.0, // distance over which terrain ramps to full amplitude
	color: 0x202833,
};

export function createTerrain(opts = {}) {
	const cfg = { ...DEFAULTS, ...opts };
	const { size, segments, amplitude, frequency, octaves, flatRadius, flatFalloff } = cfg;
	const points = segments + 1; // samples per side
	const cellSize = size / segments;
	const half = size / 2;
	const noise = makeValueNoise(cfg.seed);

	// fBm height at a world (x, z). Returns metres above y=0.
	function rawHeight(x, z) {
		let h = 0;
		let freq = frequency;
		let amp = 1;
		let norm = 0;
		for (let o = 0; o < octaves; o++) {
			// Offset each octave so they don't share lattice alignment.
			h += amp * (noise(x * freq + o * 37.1, z * freq - o * 19.7) - 0.5) * 2;
			norm += amp;
			freq *= 2;
			amp *= 0.5;
		}
		h = (h / norm) * amplitude;
		// Flatten a disc around spawn so the avatar and central props start on
		// even ground; ramp smoothly to full relief beyond flatRadius.
		const r = Math.hypot(x, z);
		const t = Math.min(1, Math.max(0, (r - flatRadius) / flatFalloff));
		const ease = t * t * (3 - 2 * t);
		return h * ease;
	}

	// COLUMN-MAJOR height buffer for Rapier: index = row + col * points.
	// Rapier maps heightfield point (row, col) to local
	//   x = (col/(points-1) - 0.5) * scale.x
	//   z = (row/(points-1) - 0.5) * scale.z
	// We fill with the SAME world→height function so collider == visual.
	const heights = new Float32Array(points * points);
	for (let col = 0; col < points; col++) {
		const x = (col / segments - 0.5) * size;
		for (let row = 0; row < points; row++) {
			const z = (row / segments - 0.5) * size;
			heights[row + col * points] = rawHeight(x, z);
		}
	}

	// Bilinear sample of the baked grid — matches the heightfield's piecewise
	// surface that physics and props stand on (analytic rawHeight would drift
	// from the discretised collider on steep cells).
	function heightAt(x, z) {
		const fx = ((x + half) / size) * segments;
		const fz = ((z + half) / size) * segments;
		const cx = Math.min(segments - 1, Math.max(0, Math.floor(fx)));
		const cz = Math.min(segments - 1, Math.max(0, Math.floor(fz)));
		const tx = Math.min(1, Math.max(0, fx - cx));
		const tz = Math.min(1, Math.max(0, fz - cz));
		const h00 = heights[cz + cx * points];
		const h10 = heights[cz + (cx + 1) * points];
		const h01 = heights[cz + 1 + cx * points];
		const h11 = heights[cz + 1 + (cx + 1) * points];
		const a = h00 + (h10 - h00) * tx;
		const b = h01 + (h11 - h01) * tx;
		return a + (b - a) * tz;
	}

	// Surface normal via central differences — for slope-aware prop placement.
	const _e = cellSize;
	function normalAt(x, z, out) {
		const hL = heightAt(x - _e, z);
		const hR = heightAt(x + _e, z);
		const hD = heightAt(x, z - _e);
		const hU = heightAt(x, z + _e);
		const nx = hL - hR;
		const nz = hD - hU;
		const ny = 2 * _e;
		const len = Math.hypot(nx, ny, nz) || 1;
		if (out) return out.set(nx / len, ny / len, nz / len);
		return { x: nx / len, y: ny / len, z: nz / len };
	}

	// Build the render mesh from the same grid. Custom BufferGeometry (rather
	// than PlaneGeometry) so vertex order is unambiguously aligned with the
	// height buffer and we control normals/UVs.
	const vertCount = points * points;
	const positions = new Float32Array(vertCount * 3);
	const uvs = new Float32Array(vertCount * 2);
	for (let col = 0; col < points; col++) {
		const x = (col / segments - 0.5) * size;
		for (let row = 0; row < points; row++) {
			const z = (row / segments - 0.5) * size;
			const vi = row + col * points;
			positions[vi * 3] = x;
			positions[vi * 3 + 1] = heights[vi];
			positions[vi * 3 + 2] = z;
			uvs[vi * 2] = col / segments;
			uvs[vi * 2 + 1] = row / segments;
		}
	}
	// Two triangles per cell. Winding chosen so normals face +Y (up).
	const indices = new Uint32Array(segments * segments * 6);
	let ii = 0;
	for (let col = 0; col < segments; col++) {
		for (let row = 0; row < segments; row++) {
			const a = row + col * points;
			const b = row + (col + 1) * points;
			const c = row + 1 + col * points;
			const d = row + 1 + (col + 1) * points;
			indices[ii++] = a;
			indices[ii++] = c;
			indices[ii++] = b;
			indices[ii++] = b;
			indices[ii++] = c;
			indices[ii++] = d;
		}
	}

	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
	geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
	geometry.setIndex(new BufferAttribute(indices, 1));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();

	const material = new MeshStandardMaterial({
		color: cfg.color,
		roughness: 0.95,
		metalness: 0.0,
	});

	const mesh = new Mesh(geometry, material);
	mesh.receiveShadow = true;
	mesh.name = 'terrain';

	// Snap an Object3D onto the surface at (x, z), keeping its base at ground.
	function placeOnGround(obj, x, z, baseOffset = 0) {
		obj.position.set(x, heightAt(x, z) + baseOffset, z);
	}

	return {
		mesh,
		material,
		heights, // Float32Array, column-major — feed directly to Rapier
		size,
		segments,
		points,
		cellSize,
		amplitude,
		heightAt,
		normalAt,
		placeOnGround,
		setColor(hex) {
			material.color.setHex(hex);
		},
		dispose() {
			geometry.dispose();
			material.dispose();
		},
	};
}

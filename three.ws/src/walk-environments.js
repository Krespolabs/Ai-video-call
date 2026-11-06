// walk-environments.js — the scene/environment registry for the /walk page.
// ==========================================================================
// The walkaround can be staged in six places: a park, a cyberpunk street, a
// beach, a gallery, an abstract void, and the three.ws virtual office. Each is
// driven by a manifest entry in public/environments/index.json (authored by
// scripts/build-walk-environments.mjs) and, except the procedural `void`, a
// real glTF scene (public/environments/<name>/scene.glb) plus an
// equirectangular HDR (env.hdr) for image-based lighting.
//
// This module is the single source of truth for LOADING an environment:
//   • fetchEnvironmentManifest()  — load + cache the manifest
//   • resolveEnvName(name)        — validate a name (URL param / storage)
//   • loadEnvironmentScenery()    — GLB → Group, each prop snapped to the
//                                   terrain surface (or the procedural void grid)
//   • loadEnvironmentHDR()        — env.hdr → PMREM-filtered IBL texture
//   • applyLighting() / applySky()— push manifest light/sky settings onto the
//                                   live rig + page background
//
// Ground + physics stay owned by walk.js (the terrain heightfield is the
// walkable surface); this module only supplies scenery, lighting, and IBL so
// the page can swap worlds without each caller re-implementing the loaders.

import { Color, EquirectangularReflectionMapping, GridHelper, Group, PMREMGenerator } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const MANIFEST_URL = '/environments/index.json';
const ASSET_BASE = '/environments/';

let _manifestPromise = null;
const _gltfLoader = new GLTFLoader();
// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
const _meshoptReady = getMeshoptDecoder().then((d) => _gltfLoader.setMeshoptDecoder(d));

// Fetch + cache the environment manifest. Resolves to
// { version, default, environments: [...] }. The promise is memoised so the
// HUD picker and the boot path share one network request.
export function fetchEnvironmentManifest() {
	if (!_manifestPromise) {
		_manifestPromise = fetch(MANIFEST_URL)
			.then((r) => {
				if (!r.ok) throw new Error(`environments manifest ${r.status}`);
				return r.json();
			})
			.catch((err) => {
				// A failed manifest must not blank the world — reset so a later
				// retry can succeed, and surface a usable single-environment shim.
				_manifestPromise = null;
				throw err;
			});
	}
	return _manifestPromise;
}

// Resolve a requested environment name against a loaded manifest, falling back
// to the manifest default (then the first entry) so a stale URL/localStorage
// value can never leave the page without a world.
export function resolveEnvName(manifest, name) {
	if (!manifest?.environments?.length) return null;
	const has = (n) => manifest.environments.some((e) => e.name === n);
	if (name && has(name)) return name;
	if (manifest.default && has(manifest.default)) return manifest.default;
	return manifest.environments[0].name;
}

export function getEnvironment(manifest, name) {
	return manifest?.environments?.find((e) => e.name === name) || null;
}

// Load an environment's scenery as a THREE.Group ready to add to the scene.
//   • GLB environments: every top-level prop node is snapped onto the terrain
//     surface via heightAt(x, z) so nothing floats or sinks on rolling ground,
//     and meshes opt into shadow casting/receiving.
//   • The procedural `void`: a two-tone grid plane (no GLB).
// Returns { group, dispose }.
export async function loadEnvironmentScenery(meta, { heightAt } = {}) {
	const group = new Group();
	group.name = `walk-env-${meta.name}`;

	if (!meta.scene) {
		if (meta.grid) group.add(buildVoidGrid(meta.grid));
		return { group, dispose: () => disposeGroup(group) };
	}

	await _meshoptReady;
	const gltf = await _gltfLoader.loadAsync(ASSET_BASE + meta.scene);
	const root = gltf.scene;
	const snap = typeof heightAt === 'function';
	for (const node of root.children) {
		if (snap) node.position.y += heightAt(node.position.x, node.position.z) || 0;
	}
	root.traverse((n) => {
		if (!n.isMesh) return;
		n.castShadow = true;
		n.receiveShadow = true;
	});
	group.add(root);
	return { group, dispose: () => disposeGroup(group) };
}

// Two-tone grid for the void: faint lines with brighter axis lines, sitting
// just above y=0 so it reads as a floor without z-fighting the ground.
function buildVoidGrid(grid) {
	const helper = new GridHelper(
		grid.size || 24,
		grid.divisions || 24,
		grid.accent || 0x6ea8ff,
		grid.color || 0x3a5e9e,
	);
	helper.position.y = 0.02;
	const mat = Array.isArray(helper.material) ? helper.material : [helper.material];
	mat.forEach((m) => {
		m.transparent = true;
		m.opacity = 0.5;
		m.depthWrite = false;
	});
	helper.name = 'void-grid';
	return helper;
}

// Load + PMREM-prefilter an environment's HDR into an IBL texture for PBR
// reflections. Returns { texture, dispose } or null when the environment ships
// no HDR (the caller then keeps its neutral room environment / flat wash).
export async function loadEnvironmentHDR(meta, renderer) {
	if (!meta.hdr || !renderer) return null;
	const loader = new HDRLoader();
	const hdr = await loader.loadAsync(ASSET_BASE + meta.hdr);
	hdr.mapping = EquirectangularReflectionMapping;
	const pmrem = new PMREMGenerator(renderer);
	pmrem.compileEquirectangularShader();
	const rt = pmrem.fromEquirectangular(hdr);
	const texture = rt.texture;
	hdr.dispose();
	pmrem.dispose();
	return { texture, dispose: () => texture.dispose() };
}

// Push the manifest's light rig onto the existing scene lights. Colours are
// sRGB hex; three converts on assignment. Direction positions the sun.
export function applyLighting(meta, { ambientLight, hemi, sun } = {}) {
	const L = meta.light;
	if (!L) return;
	if (ambientLight && L.ambient) {
		ambientLight.color.set(L.ambient.color);
		ambientLight.intensity = L.ambient.intensity;
	}
	if (hemi && L.hemi) {
		hemi.color.set(L.hemi.sky);
		hemi.groundColor.set(L.hemi.ground);
		hemi.intensity = L.hemi.intensity;
	}
	if (sun && L.sun) {
		sun.color.set(L.sun.color);
		sun.intensity = L.sun.intensity;
		const d = L.sun.direction || [4, 8, 6];
		sun.position.set(d[0], d[1], d[2]);
		sun.target?.position.set(0, 0, 0);
		sun.target?.updateMatrixWorld?.();
	}
}

// Paint the page background to the environment's sky gradient (the canvas is
// transparent, so this radial gradient is the visible "skybox").
export function applySky(meta, stageEl) {
	if (!stageEl || !meta.sky) return;
	const { top, bottom } = meta.sky;
	stageEl.style.background = `radial-gradient(120% 90% at 50% 18%, ${top} 0%, ${bottom} 72%) ${bottom}`;
}

// The CSS colour the world fades to during a swap — the environment's horizon,
// so the fade reads as dusk rather than a hard black cut on bright scenes.
export function skyFadeColor(meta) {
	return meta?.sky?.bottom || '#05070c';
}

// Best-effort recolour of the terrain tint to match the environment ground.
export function terrainColor(meta) {
	return new Color(meta?.terrain?.color || '#202833').getHex();
}

function disposeGroup(group) {
	group.traverse((n) => {
		if (n.isMesh || n.isLine || n.isLineSegments) {
			n.geometry?.dispose?.();
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			mats.forEach((m) => {
				if (!m) return;
				for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
				m.dispose?.();
			});
		}
	});
}

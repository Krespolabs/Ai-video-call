// Shared GLTFLoader with Draco + KTX2 + Meshopt wired against locally-served
// decoder binaries (copied into /public/three/{draco,basis}/ by the
// postinstall step `scripts/copy-three-decoders.mjs`). One memoised instance
// per renderer so the decoders aren't re-instantiated on every glTF load.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const DRACO_PATH = '/three/draco/';
const BASIS_PATH = '/three/basis/';

const _cache = new WeakMap();

/**
 * Return a GLTFLoader configured for compressed assets (Draco, KTX2, Meshopt).
 * Memoised per renderer — KTX2Loader's transcoder targets vary by GPU/format
 * support, so we bind the loader to the specific WebGLRenderer that was
 * passed in. Subsequent calls with the same renderer return the same loader.
 *
 * @param {import('three').WebGLRenderer} renderer
 * @returns {GLTFLoader}
 */
export function gltfLoader(renderer) {
	if (!renderer) {
		throw new Error('gltfLoader(renderer) requires a WebGLRenderer for KTX2 format detection');
	}
	const cached = _cache.get(renderer);
	if (cached) return cached;

	const loader = new GLTFLoader();
	const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
	loader.setDRACOLoader(draco);
	const ktx2 = new KTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(renderer);
	loader.setKTX2Loader(ktx2);
	loader.setMeshoptDecoder(MeshoptDecoder);

	_cache.set(renderer, loader);
	return loader;
}

/**
 * Dispose loader resources when the renderer is torn down. Idempotent.
 *
 * @param {import('three').WebGLRenderer} renderer
 */
export function disposeGltfLoader(renderer) {
	const loader = _cache.get(renderer);
	if (!loader) return;
	loader.dracoLoader?.dispose?.();
	loader.ktx2Loader?.dispose?.();
	_cache.delete(renderer);
}

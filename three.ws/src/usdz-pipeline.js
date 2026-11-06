// USDZ + half-body pipeline.
//
// Both helpers run entirely client-side:
//   1. Load a GLB Blob into a Three.js scene via GLTFLoader.
//   2. Either USDZ-export the whole scene, or strip the lower-body and GLB-
//      export the upper half.
//   3. Return the resulting Blob, ready to PUT to a presigned R2 URL.
//
// The viewer pulls the resulting URLs from the avatar record and feeds them
// into setARTarget() / loadHalfBody(), so iOS Quick Look and VR seats work
// without any external converter or hosted RPM endpoint.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { conformanceReport } from './runtime/arkit52.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { MeshStandardMaterial, Color, DoubleSide, Mesh, BufferAttribute, Vector3 } from 'three';
import { getDecoders } from './viewer/internal.js';

// Bone-name fragments that mark the lower body. Matched case-insensitively
// after stripping the standard prefixes (mixamorig:, CC_Base_, Armature|).
const LOWER_BODY_FRAGMENTS = [
	'upleg', 'leg', 'thigh', 'knee', 'shin', 'calf',
	'foot', 'toe', 'ankle',
];

function _normalizeBone(name) {
	return String(name || '')
		.toLowerCase()
		.replace(/^mixamorig:?_?/, '')
		.replace(/^cc_base_/, '')
		.replace(/^armature[:_|]/, '')
		.replace(/^rig[:_]/, '');
}

function _isLowerBody(name) {
	const norm = _normalizeBone(name);
	return LOWER_BODY_FRAGMENTS.some((f) => norm.includes(f));
}

export async function _loadGlbBlob(blob) {
	const loader = new GLTFLoader();
	// Avatars baked through the server pipeline ship as EXT_meshopt_compression,
	// and uploaded GLBs may use KHR_draco_mesh_compression. Without these
	// decoders GLTFLoader throws "setMeshoptDecoder must be called before loading
	// compressed files" (or the Draco equivalent) and the whole export fails.
	const { dracoLoader, meshoptDecoder } = await getDecoders();
	loader.setMeshoptDecoder(meshoptDecoder);
	loader.setDRACOLoader(dracoLoader);
	const arrayBuf = await blob.arrayBuffer();
	return new Promise((resolve, reject) => {
		loader.parse(arrayBuf, '', resolve, reject);
	});
}

/**
 * Bake every SkinnedMesh in the scene into a static Mesh whose vertices are
 * frozen at the current (rest / bind) pose.
 *
 * Why: three.js's USDZExporter does NOT carry skinning. It writes each mesh's
 * raw geometry attributes plus the mesh node's world matrix and nothing else —
 * the bone matrices that fan a humanoid into its T-pose, and that pin
 * accessories (glasses, shoes) onto the bones they're weighted to, are simply
 * dropped. The result in Quick Look is a collapsed avatar with limbs balled at
 * the hips and accessories floating at raw scale. We fix it here by running CPU
 * skinning per vertex (SkinnedMesh.applyBoneTransform) and emitting a plain Mesh
 * the exporter can handle losslessly.
 *
 * The baked vertices come back in the SkinnedMesh's own local space (the space
 * its matrix maps to world), so we copy that matrix onto the replacement and
 * let the exporter apply the world transform exactly as it would for any static
 * mesh.
 */
/**
 * Run CPU skinning over a SkinnedMesh at its *current* skeleton pose and return
 * the deformed vertex positions in the mesh's own local space (the frame its
 * matrix maps to world). Caller is responsible for having called
 * updateMatrixWorld() so the bone matrices are current.
 *
 * Shared by the static bake (one pose) and the animated exporter (one call per
 * sampled frame), so the skinning math lives in exactly one place.
 *
 * @param {import('three').SkinnedMesh} mesh
 * @returns {Float32Array} length = vertexCount * 3
 */
export function _bakedLocalPositions(mesh) {
	const posAttr = mesh.geometry.getAttribute('position');
	const out = new Float32Array(posAttr.count * 3);
	const v = new Vector3();
	for (let i = 0; i < posAttr.count; i++) {
		v.fromBufferAttribute(posAttr, i);
		mesh.applyBoneTransform(i, v);
		out[i * 3] = v.x;
		out[i * 3 + 1] = v.y;
		out[i * 3 + 2] = v.z;
	}
	return out;
}

/**
 * Coerce every mesh material in a scene to MeshStandardMaterial in place. Quick
 * Look's UsdPreviewSurface maps cleanly from Standard only — the exporter warns
 * and drops Unlit/Phong/Toon meshes otherwise. Shared by the static and
 * animated USDZ paths.
 *
 * @param {import('three').Object3D} scene
 */
export function _coerceMaterialsToStandard(scene) {
	scene.traverse((obj) => {
		if (!obj.isMesh) return;
		const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
		mats.forEach((m, i) => {
			if (!m || m.isMeshStandardMaterial) return;
			const replacement = new MeshStandardMaterial({
				color: m.color ? m.color.clone() : new Color(0xffffff),
				map: m.map || null,
				normalMap: m.normalMap || null,
				roughness: typeof m.roughness === 'number' ? m.roughness : 0.85,
				metalness: typeof m.metalness === 'number' ? m.metalness : 0.0,
				transparent: !!m.transparent,
				opacity: typeof m.opacity === 'number' ? m.opacity : 1,
				side: m.side ?? DoubleSide,
			});
			if (Array.isArray(obj.material)) obj.material[i] = replacement;
			else obj.material = replacement;
		});
	});
}

/**
 * Guarantee every renderable mesh in the scene carries a `normal` attribute.
 * three's USDZExporter logs "USDZExporter: Normals missing." and writes flat,
 * lighting-broken geometry for any mesh without normals — common for procedural
 * or decimated props that ship position-only. The skinned-mesh bake already
 * recomputes normals on the geometry it replaces; this covers everything else
 * (static meshes, accessories) right before export. Shared by both USDZ paths.
 *
 * @param {import('three').Object3D} scene
 */
export function _ensureNormals(scene) {
	scene.traverse((obj) => {
		if (!obj.isMesh || !obj.geometry) return;
		const geom = obj.geometry;
		if (geom.getAttribute('normal')) return;
		if (!geom.getAttribute('position')) return;
		geom.computeVertexNormals();
	});
}

export function _bakeSkinnedMeshesForExport(scene) {
	scene.updateMatrixWorld(true);

	const skinned = [];
	scene.traverse((obj) => {
		if (obj.isSkinnedMesh && obj.skeleton?.bones?.length) skinned.push(obj);
	});

	for (const mesh of skinned) {
		const src = mesh.geometry;
		if (!src.getAttribute('position')) continue;

		const baked = src.clone();
		baked.setAttribute('position', new BufferAttribute(_bakedLocalPositions(mesh), 3));
		// Skinning data is meaningless on a static mesh and confuses the exporter.
		baked.deleteAttribute('skinIndex');
		baked.deleteAttribute('skinWeight');
		// Normals were authored for the bind pose; recompute so shading matches
		// the baked geometry in Quick Look.
		baked.computeVertexNormals();

		const replacement = new Mesh(baked, mesh.material);
		replacement.name = mesh.name;
		replacement.visible = mesh.visible;
		replacement.castShadow = mesh.castShadow;
		replacement.receiveShadow = mesh.receiveShadow;
		// applyBoneTransform returns local-space verts, so the replacement shares
		// the original's local transform; the exporter applies it as world.
		replacement.position.copy(mesh.position);
		replacement.quaternion.copy(mesh.quaternion);
		replacement.scale.copy(mesh.scale);

		const parent = mesh.parent || scene;
		parent.add(replacement);
		parent.remove(mesh);
	}
}

/**
 * Convert a GLB Blob to a USDZ Blob using three.js's USDZExporter.
 *
 * Materials are coerced to MeshStandardMaterial — USDZ only supports
 * UsdPreviewSurface, and the exporter throws on unlit / phong / toon.
 *
 * @param {Blob} glbBlob — bytes of the source GLB
 * @returns {Promise<Blob>} bytes packaged as a .usdz (zip-based) blob
 */
export async function glbBlobToUsdzBlob(glbBlob) {
	const gltf = await _loadGlbBlob(glbBlob);
	const scene = gltf.scene || gltf.scenes?.[0];
	if (!scene) throw new Error('USDZ: glb contained no scene');

	// Freeze skinned avatars into static geometry — USDZExporter ignores
	// skeletons, so without this the avatar exports collapsed and distorted.
	_bakeSkinnedMeshesForExport(scene);

	// Quick Look refuses Unlit/Phong/Toon materials; coerce to standard. The
	// visual result is close-to-identical for the typical avatar PBR setup.
	_coerceMaterialsToStandard(scene);

	// Position-only meshes (props, decimated accessories) would export flat-shaded
	// and trigger the exporter's "Normals missing" warning — fill them in first.
	_ensureNormals(scene);

	const exporter = new USDZExporter();
	const usdzBytes = await exporter.parseAsync(scene);
	return new Blob([usdzBytes], { type: 'model/vnd.usdz+zip' });
}

/**
 * Build a half-body GLB from a full-body GLB by hiding the lower-body
 * skeleton + skinned vertices, then GLB-exporting the result.
 *
 * Strategy: walk every skinned mesh, identify bone indices whose bone name
 * looks like leg/foot/toe, and zero the bone weights for those vertices.
 * Bone hierarchy is left intact so animation clips that reference lower
 * bones still apply cleanly — they just don't deform any geometry.
 *
 * @param {Blob} glbBlob — bytes of the source GLB
 * @returns {Promise<Blob>} half-body GLB blob
 */
export async function glbBlobToHalfBodyBlob(glbBlob) {
	const gltf = await _loadGlbBlob(glbBlob);
	const scene = gltf.scene || gltf.scenes?.[0];
	if (!scene) throw new Error('halfbody: glb contained no scene');

	let trimmedAny = false;

	scene.traverse((obj) => {
		if (!obj.isSkinnedMesh || !obj.skeleton) return;
		const bones = obj.skeleton.bones || [];
		const lowerBoneSet = new Set();
		bones.forEach((b, idx) => {
			if (_isLowerBody(b.name)) lowerBoneSet.add(idx);
		});
		if (!lowerBoneSet.size) return;

		const skinIdx = obj.geometry.getAttribute('skinIndex');
		const skinW = obj.geometry.getAttribute('skinWeight');
		if (!skinIdx || !skinW) return;

		// Zero out weights of vertices that are predominantly bound to lower
		// bones. We keep the geometry around — Quick Look-friendly and avoids
		// expensive re-indexing — and rely on the weight=0 to collapse those
		// triangles to the rest pose (head/torso).
		const count = skinIdx.count;
		for (let v = 0; v < count; v++) {
			let lowerWeight = 0;
			for (let i = 0; i < 4; i++) {
				const bone = skinIdx.getComponent(v, i);
				const w = skinW.getComponent(v, i);
				if (lowerBoneSet.has(bone)) lowerWeight += w;
			}
			if (lowerWeight > 0.5) {
				for (let i = 0; i < 4; i++) {
					skinW.setComponent(v, i, 0);
				}
			}
		}
		skinW.needsUpdate = true;
		trimmedAny = true;
	});

	if (!trimmedAny) {
		throw new Error('halfbody: no recognizable lower-body bones — skipping');
	}

	const exporter = new GLTFExporter();
	const buffer = await new Promise((resolve, reject) => {
		exporter.parse(
			scene,
			(out) => resolve(out),
			(err) => reject(err),
			{ binary: true, embedImages: true },
		);
	});
	return new Blob([buffer], { type: 'model/gltf-binary' });
}

/**
 * Inspect a GLB Blob and report which of the 52 canonical ARKit blendshapes
 * the avatar implements (including via known aliases — snake_case, _L/_R
 * suffixes, combined-shape fanout). Used by the upload pipeline to attach
 * coverage metadata so the editor can surface gaps to the user and the
 * Empathy Layer knows up-front what it can drive.
 *
 * @param {Blob} glbBlob
 * @returns {Promise<{ implemented: string[], missing: string[], coverage: number }>}
 */
export async function glbBlobToArkitReport(glbBlob) {
	const gltf = await _loadGlbBlob(glbBlob);
	const scene = gltf.scene || gltf.scenes?.[0];
	if (!scene) throw new Error('arkit: glb contained no scene');
	return conformanceReport(scene);
}

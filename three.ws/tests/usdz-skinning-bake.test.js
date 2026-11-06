// Regression test for the USDZ skinning bake.
//
// three.js's USDZExporter drops skeletons entirely — it writes raw geometry
// attributes plus the mesh node's world matrix and nothing else. For skinned
// humanoid avatars that means Quick Look renders a collapsed, distorted figure
// with accessories floating at raw scale (the "giant glasses" bug).
//
// _bakeSkinnedMeshesForExport() fixes this by running CPU skinning per vertex
// and replacing each SkinnedMesh with a static Mesh frozen at the current pose.
// This test poses a bone and verifies the baked vertices follow it, and that
// the replacement is a plain Mesh with no skinning attributes left.

import { describe, it, expect } from 'vitest';
import {
	Bone,
	Skeleton,
	SkinnedMesh,
	Mesh,
	BufferGeometry,
	Float32BufferAttribute,
	Uint16BufferAttribute,
	MeshStandardMaterial,
	Scene,
} from 'three';

import { _bakeSkinnedMeshesForExport, _ensureNormals } from '../src/usdz-pipeline.js';

function buildSkinnedTriangle() {
	const geo = new BufferGeometry();
	// A triangle whose three vertices are each fully bound to bone 0.
	geo.setAttribute('position', new Float32BufferAttribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3));
	geo.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
	geo.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));

	const bone = new Bone();
	const skeleton = new Skeleton([bone]); // boneInverses captured at origin → identity

	const mesh = new SkinnedMesh(geo, new MeshStandardMaterial());
	mesh.add(bone);
	mesh.bind(skeleton); // bindMatrix = mesh.matrixWorld (identity at origin)

	return { mesh, bone };
}

describe('_bakeSkinnedMeshesForExport', () => {
	it('freezes the posed skinned mesh into a static Mesh that follows the bone', () => {
		const { mesh, bone } = buildSkinnedTriangle();
		// Move the only bone — every vertex (fully weighted to it) should shift.
		bone.position.set(5, 0, 0);

		const scene = new Scene();
		scene.add(mesh);

		_bakeSkinnedMeshesForExport(scene);

		// The SkinnedMesh is gone, replaced by a plain Mesh.
		const skinned = [];
		const statics = [];
		scene.traverse((o) => {
			if (o.isSkinnedMesh) skinned.push(o);
			else if (o.isMesh) statics.push(o);
		});
		expect(skinned).toHaveLength(0);
		expect(statics).toHaveLength(1);

		const baked = statics[0];
		expect(baked).toBeInstanceOf(Mesh);

		// Vertex 0 was (0,1,0); bound to a bone translated +5 on X → (5,1,0).
		const pos = baked.geometry.getAttribute('position');
		expect(pos.getX(0)).toBeCloseTo(5, 5);
		expect(pos.getY(0)).toBeCloseTo(1, 5);
		expect(pos.getZ(0)).toBeCloseTo(0, 5);

		// Skinning attributes are stripped from the static mesh.
		expect(baked.geometry.getAttribute('skinIndex')).toBeUndefined();
		expect(baked.geometry.getAttribute('skinWeight')).toBeUndefined();
	});

	it('leaves a scene with no skinned meshes untouched', () => {
		const scene = new Scene();
		const plain = new Mesh(new BufferGeometry(), new MeshStandardMaterial());
		scene.add(plain);

		expect(() => _bakeSkinnedMeshesForExport(scene)).not.toThrow();
		expect(scene.children).toContain(plain);
	});
});

describe('_ensureNormals', () => {
	it('computes normals for a position-only mesh so USDZExporter does not warn', () => {
		const geo = new BufferGeometry();
		geo.setAttribute('position', new Float32BufferAttribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3));
		expect(geo.getAttribute('normal')).toBeUndefined();

		const scene = new Scene();
		scene.add(new Mesh(geo, new MeshStandardMaterial()));

		_ensureNormals(scene);

		const normal = geo.getAttribute('normal');
		expect(normal).toBeDefined();
		expect(normal.count).toBe(3);
	});

	it('leaves an existing normal attribute untouched', () => {
		const geo = new BufferGeometry();
		geo.setAttribute('position', new Float32BufferAttribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3));
		const authored = new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3);
		geo.setAttribute('normal', authored);

		const scene = new Scene();
		scene.add(new Mesh(geo, new MeshStandardMaterial()));

		_ensureNormals(scene);

		expect(geo.getAttribute('normal')).toBe(authored);
	});

	it('ignores meshes without a position attribute', () => {
		const scene = new Scene();
		scene.add(new Mesh(new BufferGeometry(), new MeshStandardMaterial()));
		expect(() => _ensureNormals(scene)).not.toThrow();
	});
});

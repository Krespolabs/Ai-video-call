// Reconstruct a real GLB's skeleton as a THREE.Object3D graph in Node, without
// GLTFLoader (which needs `self`/DOM). We parse the GLB's JSON chunk directly —
// exactly the technique scripts/build-canonical-rest.mjs uses — and rebuild the
// node hierarchy with each node's authored TRS, marking skin joints as Bones and
// adding a SkinnedMesh bound to the skeleton so the retarget module's traversal
// (canonicalNodeMapFromObject / canonicalRestMapFromObject) finds the rig the way
// it would in the browser. Used by the cz/michelle parity tests to prove the bind
// correction lands real limb poses, not just an upright Hips.

import fs from 'node:fs';
import {
	Object3D,
	Bone,
	SkinnedMesh,
	Skeleton,
	BufferGeometry,
	Vector3,
	AnimationMixer,
} from 'three';
import { canonicalNodeMapFromObject } from '../../src/animation-retarget.js';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Parse the JSON chunk of a binary glTF (GLB). */
export function readGlbJson(file) {
	const buf = fs.readFileSync(file);
	if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file}: not a GLB (bad magic)`);
	const jsonLen = buf.readUInt32LE(12);
	if (buf.readUInt32LE(16) !== CHUNK_JSON) throw new Error(`${file}: first chunk is not JSON`);
	return JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
}

/**
 * Build a THREE graph (scene root) from a GLB file, honoring node hierarchy and
 * each node's local rest TRS. Skin joints become Bones; a SkinnedMesh bound to
 * the joint skeleton is attached so skeleton-based traversal works too. World
 * matrices are current on return.
 *
 * @param {string} file  path to a .glb
 * @returns {import('three').Object3D}
 */
export function buildGraphFromGlb(file) {
	const gltf = readGlbJson(file);
	const nodes = gltf.nodes || [];
	const skin = (gltf.skins || [])[0];
	const jointSet = new Set(skin?.joints || []);

	const objs = nodes.map((n, i) => {
		const o = jointSet.has(i) ? new Bone() : new Object3D();
		o.name = n.name || `node${i}`;
		if (Array.isArray(n.translation)) o.position.fromArray(n.translation);
		if (Array.isArray(n.rotation)) o.quaternion.fromArray(n.rotation);
		if (Array.isArray(n.scale)) o.scale.fromArray(n.scale);
		return o;
	});
	nodes.forEach((n, i) => {
		for (const c of n.children || []) objs[i].add(objs[c]);
	});

	const scene = new Object3D();
	scene.name = 'Scene';
	const roots = gltf.scenes?.[gltf.scene || 0]?.nodes || [];
	for (const r of roots) scene.add(objs[r]);

	if (skin) {
		const bones = skin.joints.map((j) => objs[j]);
		scene.updateMatrixWorld(true);
		const mesh = new SkinnedMesh(new BufferGeometry());
		mesh.name = 'SkinnedMesh';
		mesh.bind(new Skeleton(bones));
		scene.add(mesh);
	}
	scene.updateMatrixWorld(true);
	return scene;
}

// Limb segments as canonical (parent → child) bone pairs. A segment's world
// direction is the unit vector from the parent joint to the child joint — the
// rig-independent quantity that must match across conventions once retargeted.
export const LIMB_SEGMENTS = [
	['leftUpperArm', 'LeftArm', 'LeftForeArm'],
	['leftForeArm', 'LeftForeArm', 'LeftHand'],
	['rightUpperArm', 'RightArm', 'RightForeArm'],
	['rightForeArm', 'RightForeArm', 'RightHand'],
	['leftThigh', 'LeftUpLeg', 'LeftLeg'],
	['leftShin', 'LeftLeg', 'LeftFoot'],
	['rightThigh', 'RightUpLeg', 'RightLeg'],
	['rightShin', 'RightLeg', 'RightFoot'],
];

/**
 * Drive a retargeted clip onto a graph at one time and read each limb segment's
 * world-space unit direction. Uses a real AnimationMixer — the runtime path.
 *
 * @param {import('three').Object3D} scene
 * @param {import('three').AnimationClip} retargetedClip
 * @param {number} time  seconds into the clip
 * @returns {Record<string, Vector3>}
 */
export function limbDirections(scene, retargetedClip, time) {
	const mixer = new AnimationMixer(scene);
	mixer.clipAction(retargetedClip).play();
	mixer.setTime(time);
	scene.updateMatrixWorld(true);

	const map = canonicalNodeMapFromObject(scene);
	const worldPos = (canonical) => {
		const node = scene.getObjectByName(map.get(canonical));
		const v = new Vector3();
		node.getWorldPosition(v);
		return v;
	};

	const out = {};
	for (const [key, parent, child] of LIMB_SEGMENTS) {
		if (!map.has(parent) || !map.has(child)) continue;
		out[key] = worldPos(child).sub(worldPos(parent)).normalize();
	}
	return out;
}

/** Angle (degrees) between two unit vectors. */
export function angleBetweenDeg(a, b) {
	const dot = Math.min(1, Math.max(-1, a.dot(b)));
	return (Math.acos(dot) * 180) / Math.PI;
}

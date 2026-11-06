/**
 * Rig-mode gate — the pure twin of AnimationManager.supportsCanonicalClips().
 *
 * The pre-baked clip library addresses tracks by the canonical bone names in
 * src/glb-canonicalize.js. A rig the canonicalizer can map enough of can be
 * driven by those clips ("canonical" mode); one it can't — too few mappable
 * bones, or no SkinnedMesh to skin at all — must fall back to a known-good
 * default rig rather than freeze in a bind-pose T-pose ("fallback" mode).
 *
 * This module is the side-effect-free decision: it takes a rig description
 * (or a traversable Three.js root via inspectRig) and returns the mode plus
 * the evidence behind it. AnimationManager.supportsCanonicalClips() applies
 * the same bar live; the bone threshold here must match it.
 */

import { canonicalizeBoneName } from '../glb-canonicalize.js';

/**
 * Minimum number of distinct canonical bones a rig must expose to drive the
 * baked clip library. Mirrors the live AnimationManager gate exactly — drop
 * below this and idle/walk would only animate a fraction of the skeleton, so
 * we fall back to the default rig instead.
 */
export const MIN_CANONICAL_BONES = 8;

/**
 * Count how many distinct canonical bones a list of raw bone names resolves to.
 * Deduped so a rig that ships a bone twice (de-dup suffixes, mirrored helpers)
 * can't inflate its way past the threshold.
 *
 * @param {string[]} boneNames
 * @returns {number}
 */
function countCanonicalBones(boneNames) {
	const seen = new Set();
	for (const name of boneNames) {
		const canonical = canonicalizeBoneName(name);
		if (canonical) seen.add(canonical);
	}
	return seen.size;
}

/**
 * Decide whether a rig can drive the canonical clip library.
 *
 * @param {{ hasSkinnedMesh?: boolean, boneNames?: string[] }} [info]
 * @returns {{ mode: 'canonical'|'fallback', reason: string, canonicalCount: number, hasSkinnedMesh: boolean }}
 */
export function decideRigMode(info = {}) {
	const hasSkinnedMesh = !!info.hasSkinnedMesh;
	const boneNames = Array.isArray(info.boneNames) ? info.boneNames : [];

	if (!hasSkinnedMesh) {
		return {
			mode: 'fallback',
			reason: 'No SkinnedMesh — nothing to skin, so the canonical clips have nothing to drive.',
			canonicalCount: 0,
			hasSkinnedMesh: false,
		};
	}

	const canonicalCount = countCanonicalBones(boneNames);
	if (canonicalCount < MIN_CANONICAL_BONES) {
		return {
			mode: 'fallback',
			reason: `Only ${canonicalCount} canonical bone(s) — below the ${MIN_CANONICAL_BONES} the baked clips need.`,
			canonicalCount,
			hasSkinnedMesh: true,
		};
	}

	return {
		mode: 'canonical',
		reason: `${canonicalCount} canonical bones mapped — drives the baked clip library.`,
		canonicalCount,
		hasSkinnedMesh: true,
	};
}

/**
 * Collect the canonicalizer's inputs from a traversable Three.js root: whether
 * any node is a SkinnedMesh and the names of every bone node. Safe on a null
 * or non-traversable root.
 *
 * @param {{ traverse?: (fn: (node: any) => void) => void }} root
 * @returns {{ hasSkinnedMesh: boolean, boneNames: string[] }}
 */
export function inspectRig(root) {
	const result = { hasSkinnedMesh: false, boneNames: [] };
	if (!root || typeof root.traverse !== 'function') return result;

	root.traverse((node) => {
		if (!node) return;
		if (node.isSkinnedMesh) result.hasSkinnedMesh = true;
		if ((node.isBone || node.type === 'Bone') && typeof node.name === 'string' && node.name) {
			result.boneNames.push(node.name);
		}
	});
	return result;
}

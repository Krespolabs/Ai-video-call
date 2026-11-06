/**
 * Rig-mode gate — the pure twin of AnimationManager.supportsCanonicalClips().
 * A rig the canonicalizer can't drive must fall back to the default rig, never a
 * frozen T-pose. This pins that decision and its parity with the live gate's bar.
 */

import { describe, it, expect } from 'vitest';
import { decideRigMode, inspectRig, MIN_CANONICAL_BONES } from '../src/embodiment/rig-mode.js';

const HUMANOID_BONES = [
	'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'RightArm',
	'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg',
];

describe('decideRigMode', () => {
	it('falls back when there is no SkinnedMesh', () => {
		const r = decideRigMode({ hasSkinnedMesh: false, boneNames: HUMANOID_BONES });
		expect(r.mode).toBe('fallback');
		expect(r.reason).toMatch(/SkinnedMesh/i);
	});

	it('falls back when too few bones canonicalize', () => {
		const r = decideRigMode({ hasSkinnedMesh: true, boneNames: ['Hips', 'Spine', 'Head'] });
		expect(r.mode).toBe('fallback');
		expect(r.canonicalCount).toBeLessThan(MIN_CANONICAL_BONES);
	});

	it('drives the canonical library for a real humanoid', () => {
		const r = decideRigMode({ hasSkinnedMesh: true, boneNames: HUMANOID_BONES });
		expect(r.mode).toBe('canonical');
		expect(r.canonicalCount).toBeGreaterThanOrEqual(MIN_CANONICAL_BONES);
	});

	it('handles missing / empty input without throwing', () => {
		expect(decideRigMode().mode).toBe('fallback');
		expect(decideRigMode({}).mode).toBe('fallback');
	});

	it('its bar matches the AnimationManager gate (8 canonical bones)', () => {
		expect(MIN_CANONICAL_BONES).toBe(8);
	});
});

describe('inspectRig', () => {
	it('collects bone names and the skinned-mesh flag from a traversable root', () => {
		const root = {
			traverse(fn) {
				fn({ isSkinnedMesh: true });
				fn({ isBone: true, name: 'Hips' });
				fn({ type: 'Bone', name: 'Spine' });
				fn({ name: 'SomeNodeName' });
			},
		};
		const info = inspectRig(root);
		expect(info.hasSkinnedMesh).toBe(true);
		expect(info.boneNames).toContain('Hips');
		expect(info.boneNames).toContain('Spine');
	});

	it('is safe on a null root', () => {
		expect(inspectRig(null)).toEqual({ hasSkinnedMesh: false, boneNames: [] });
	});
});

import { describe, it, expect } from 'vitest';
import { Quaternion, Euler } from 'three';
import {
	MannequinRig,
	mirrorBoneName,
	reflectWorldQuaternion,
} from '../src/pose-rig.js';
import { clonePose, posesEqual } from '../src/pose-animation.js';

describe('mirrorBoneName', () => {
	it('swaps Left ↔ Right and leaves center bones alone', () => {
		expect(mirrorBoneName('LeftArm')).toBe('RightArm');
		expect(mirrorBoneName('RightForeArm')).toBe('LeftForeArm');
		expect(mirrorBoneName('LeftHandIndex2')).toBe('RightHandIndex2');
		expect(mirrorBoneName('Hips')).toBe('Hips');
		expect(mirrorBoneName('Spine2')).toBe('Spine2');
		expect(mirrorBoneName('Head')).toBe('Head');
	});
});

describe('reflectWorldQuaternion', () => {
	it('keeps x, negates y and z (sagittal-plane reflection)', () => {
		const q = new Quaternion(0.1, 0.2, 0.3, 0.9);
		reflectWorldQuaternion(q);
		expect(q.x).toBeCloseTo(0.1, 12);
		expect(q.y).toBeCloseTo(-0.2, 12);
		expect(q.z).toBeCloseTo(-0.3, 12);
		expect(q.w).toBeCloseTo(0.9, 12);
	});
});

describe('posesEqual / clonePose', () => {
	const pose = {
		bones: { Hips: [0, 0, 0, 1], LeftArm: [0.1, 0.2, 0.3, 0.92] },
		rootPosition: { x: 0.5, y: 1, z: 0 },
	};

	it('clone is a deep, independent copy that compares equal', () => {
		const copy = clonePose(pose);
		expect(posesEqual(pose, copy)).toBe(true);
		copy.bones.LeftArm[0] = 0.99;
		expect(pose.bones.LeftArm[0]).toBe(0.1);
		expect(posesEqual(pose, copy)).toBe(false);
	});

	it('detects differing root position', () => {
		const copy = clonePose(pose);
		copy.rootPosition.x = 0.5 + 1e-2;
		expect(posesEqual(pose, copy)).toBe(false);
	});

	it('tolerates sub-epsilon noise', () => {
		const copy = clonePose(pose);
		copy.bones.LeftArm[1] += 1e-6;
		expect(posesEqual(pose, copy)).toBe(true);
	});
});

describe('rig.mirrorPose()', () => {
	function posed() {
		const rig = new MannequinRig();
		rig.setBoneEuler('LeftArm', { x: 0.4, y: 0.2, z: -0.7 });
		rig.setBoneEuler('RightLeg', { x: 0.3, y: 0, z: 0.1 });
		rig.setBoneEuler('Spine', { x: 0, y: 0.25, z: 0 });
		return rig;
	}

	it('is an involution — mirroring twice restores the original pose', () => {
		const rig = posed();
		const before = clonePose(rig.getPose());
		rig.mirrorPose();
		rig.mirrorPose();
		expect(posesEqual(before, rig.getPose(), 1e-6)).toBe(true);
	});

	it('actually changes an asymmetric pose', () => {
		const rig = posed();
		const before = clonePose(rig.getPose());
		rig.mirrorPose();
		expect(posesEqual(before, rig.getPose())).toBe(false);
	});

	it('reflects the left arm onto the right (and vice versa)', () => {
		const rig = posed();
		const before = clonePose(rig.getPose());
		rig.mirrorPose();
		const after = rig.getPose();
		// Left arm's pre-mirror rotation, reflected, lands on the right arm.
		const expected = reflectWorldQuaternion(
			new Quaternion(...before.bones.LeftArm),
		);
		const got = new Quaternion(...after.bones.RightArm);
		expect(got.angleTo(expected)).toBeLessThan(1e-6);
	});
});

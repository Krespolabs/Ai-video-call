import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { solvePose, solveSpine, landmarkToAvatar, REST_DIR, LM } from '../src/runtime/pose-solve.js';

// Build a 33-slot landmark array with every joint occluded (visibility 0), then
// let each test light up only the joints it cares about.
function blankPose() {
	return Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
}

function set(pose, idx, x, y, z, visibility = 1) {
	pose[idx] = { x, y, z, visibility };
}

// Apply a quaternion to a fresh copy of a rest direction.
function applied(q, restDir) {
	return restDir.clone().applyQuaternion(q);
}

describe('landmarkToAvatar', () => {
	it('flips MediaPipe Y-down/Z-toward-camera into avatar Y-up/Z-forward', () => {
		const v = landmarkToAvatar({ x: 0.3, y: 0.5, z: 0.2 }, false);
		expect(v.x).toBeCloseTo(0.3, 6);
		expect(v.y).toBeCloseTo(-0.5, 6);
		expect(v.z).toBeCloseTo(-0.2, 6);
	});

	it('mirror negates X', () => {
		const v = landmarkToAvatar({ x: 0.3, y: 0.5, z: 0.2 }, true);
		expect(v.x).toBeCloseTo(-0.3, 6);
	});
});

describe('solvePose — arms', () => {
	it('left arm hanging straight down rotates the +X rest axis onto −Y', () => {
		const pose = blankPose();
		set(pose, LM.LEFT_SHOULDER, 0, 0, 0);
		set(pose, LM.LEFT_ELBOW, 0, 1, 0); // MP +y is down
		const { bones } = solvePose(pose, { legs: false });
		expect(bones.LeftArm).toBeDefined();
		const dir = applied(bones.LeftArm, REST_DIR.LeftArm);
		expect(dir.x).toBeCloseTo(0, 5);
		expect(dir.y).toBeCloseTo(-1, 5);
		expect(dir.z).toBeCloseTo(0, 5);
	});

	it('forearm solves independently from the upper arm endpoint', () => {
		const pose = blankPose();
		set(pose, LM.LEFT_ELBOW, 0, 0, 0);
		set(pose, LM.LEFT_WRIST, 0, 0, 1); // wrist toward camera (MP +z)
		const { bones } = solvePose(pose, { legs: false });
		expect(bones.LeftForeArm).toBeDefined();
		const dir = applied(bones.LeftForeArm, REST_DIR.LeftForeArm);
		// avatar +z is forward; MP +z maps to avatar −z
		expect(dir.z).toBeCloseTo(-1, 5);
	});

	it('mirror flips the resolved direction across X', () => {
		const pose = blankPose();
		set(pose, LM.RIGHT_SHOULDER, 0, 0, 0);
		set(pose, LM.RIGHT_ELBOW, 2, 0, 0);
		const plain = solvePose(pose, { legs: false }).bones.RightArm;
		const mirrored = solvePose(pose, { legs: false, mirror: true }).bones.RightArm;
		const dirPlain = applied(plain, REST_DIR.RightArm);
		const dirMirror = applied(mirrored, REST_DIR.RightArm);
		expect(dirPlain.x).toBeCloseTo(-dirMirror.x, 5);
	});
});

describe('solvePose — visibility gating', () => {
	it('drops a segment when an endpoint is below the visibility threshold', () => {
		const pose = blankPose();
		set(pose, LM.LEFT_SHOULDER, 0, 0, 0, 1);
		set(pose, LM.LEFT_ELBOW, 0, 1, 0, 0.1); // low confidence
		const { bones, missing } = solvePose(pose, { legs: false, minVisibility: 0.5 });
		expect(bones.LeftArm).toBeUndefined();
		expect(missing).toContain('LeftArm');
	});

	it('reports __no_pose__ for an empty/short landmark array', () => {
		const { bones, missing } = solvePose([], {});
		expect(Object.keys(bones)).toHaveLength(0);
		expect(missing).toContain('__no_pose__');
	});
});

describe('solveSpine', () => {
	it('returns near-identity when the torso is upright', () => {
		const pose = blankPose();
		set(pose, LM.LEFT_SHOULDER, -0.2, 0, 0);
		set(pose, LM.RIGHT_SHOULDER, 0.2, 0, 0);
		set(pose, LM.LEFT_HIP, -0.2, 1, 0);
		set(pose, LM.RIGHT_HIP, 0.2, 1, 0);
		const q = solveSpine(pose, false);
		expect(q).not.toBeNull();
		const dir = applied(q, REST_DIR.Spine);
		// upright torso → spine still points +Y
		expect(dir.y).toBeCloseTo(1, 5);
	});

	it('tilts forward when shoulders lean toward the camera', () => {
		const pose = blankPose();
		set(pose, LM.LEFT_SHOULDER, -0.2, 0, 0.5);
		set(pose, LM.RIGHT_SHOULDER, 0.2, 0, 0.5);
		set(pose, LM.LEFT_HIP, -0.2, 1, 0);
		set(pose, LM.RIGHT_HIP, 0.2, 1, 0);
		const q = solveSpine(pose, false);
		const dir = applied(q, REST_DIR.Spine);
		// leaning toward camera → spine tip gains −Z (avatar forward)
		expect(dir.z).toBeLessThan(0);
		expect(dir.y).toBeGreaterThan(0);
	});
});

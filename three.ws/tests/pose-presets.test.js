/**
 * Pose preset library — structural, sync, and geometry tests.
 *
 * The preset data is the single source the /pose UI renders AND the paid
 * `get_pose_seed` MCP tool returns, so a malformed preset (bad joint name,
 * out-of-range axis) ships straight to users and paying agents. These tests
 * pin the contract:
 *
 *   1. Structure  — every preset uses only real mannequin joints and the three
 *                   Euler axes, with a unique id and a known group.
 *   2. Sync       — the in-repo src/pose-presets.js and the vendored copy the
 *                   MCP package publishes (mcp-server/src/lib/pose-presets.js)
 *                   are byte-identical in their preset data, so a pose added in
 *                   the studio is reachable from the tool and vice-versa.
 *   3. Geometry   — presets are validated against the real Mannequin forward
 *                   kinematics: a salute's hand actually reaches the head, a
 *                   facepalm's hand reaches the face, no preset buries a hand
 *                   in the floor. This is what makes "correct full joint
 *                   rotations" a checkable claim rather than a hand-wave.
 */

import { Vector3 } from 'three';
import { describe, it, expect } from 'vitest';
import {
	PRESETS,
	PRESET_GROUPS,
	getPresetById,
	getPresetsByGroup,
} from '../src/pose-presets.js';
import { PRESETS as MCP_PRESETS } from '../mcp-server/src/lib/pose-presets.js';
import { Mannequin, JOINT_NAMES } from '../src/pose-mannequin.js';

const VALID_JOINTS = new Set(JOINT_NAMES);
const AXES = ['x', 'y', 'z'];

// World-space tip of a hand: the wrist origin offset down its local -Y by the
// hand length (male build handLen = 0.18), matching how the mesh hangs.
function handTip(m, side) {
	m.root.updateMatrixWorld(true);
	return m.joints['wrist' + side].localToWorld(new Vector3(0, -0.18, 0));
}
function jointWorld(m, name) {
	m.root.updateMatrixWorld(true);
	return m.joints[name].getWorldPosition(new Vector3());
}

describe('pose preset structure', () => {
	it('has unique ids', () => {
		const ids = PRESETS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every preset has a label and a known group', () => {
		for (const p of PRESETS) {
			expect(p.label, p.id).toBeTruthy();
			expect(PRESET_GROUPS, p.id).toContain(p.group);
		}
	});

	it('every pose entry targets a real joint (or rootPosition) on the three axes', () => {
		for (const p of PRESETS) {
			for (const [joint, rot] of Object.entries(p.pose)) {
				if (joint === 'rootPosition') {
					for (const a of AXES) {
						if (rot[a] !== undefined) expect(typeof rot[a], `${p.id}.rootPosition.${a}`).toBe('number');
					}
					continue;
				}
				expect(VALID_JOINTS.has(joint), `${p.id}: unknown joint "${joint}"`).toBe(true);
				for (const a of AXES) {
					if (rot[a] !== undefined) {
						expect(Number.isFinite(rot[a]), `${p.id}.${joint}.${a}`).toBe(true);
					}
				}
			}
		}
	});

	it('getPresetById and getPresetsByGroup stay consistent with the array', () => {
		expect(getPresetById('salute')?.label).toBe('Salute');
		expect(getPresetById('does-not-exist')).toBeNull();
		const byGroup = getPresetsByGroup();
		const total = Object.values(byGroup).reduce((n, arr) => n + arr.length, 0);
		expect(total).toBe(PRESETS.length);
		for (const group of PRESET_GROUPS) expect(Array.isArray(byGroup[group])).toBe(true);
	});
});

describe('src ↔ MCP preset sync', () => {
	// The MCP package vendors a hand-synced copy; if they drift, agents calling
	// get_pose_seed get a different pose than the /pose page shows for the same id.
	it('the published MCP copy is identical to the in-repo source', () => {
		expect(MCP_PRESETS.map((p) => p.id)).toEqual(PRESETS.map((p) => p.id));
		expect(JSON.stringify(MCP_PRESETS)).toBe(JSON.stringify(PRESETS));
	});
});

describe('pose geometry (real mannequin forward kinematics)', () => {
	it('no preset drives a hand or the head below the floor', () => {
		for (const p of PRESETS) {
			const m = new Mannequin({ build: 'male' });
			m.applyPose(p.pose);
			const head = jointWorld(m, 'head');
			// Negative tolerance: floor-seated poses (sit-floor, meditate) lower the
			// whole figure via rootPosition so resting hands dip just below y=0, but
			// nothing should sink a hand a third of a metre underground.
			expect(handTip(m, 'L').y, `${p.id} L hand`).toBeGreaterThan(-0.30);
			expect(handTip(m, 'R').y, `${p.id} R hand`).toBeGreaterThan(-0.30);
			expect(head.y, `${p.id} head`).toBeGreaterThan(0.2);
		}
	});

	it('salute brings the right hand up to the head', () => {
		const m = new Mannequin({ build: 'male' });
		m.applyPose(getPresetById('salute').pose);
		const head = jointWorld(m, 'head');
		const hand = handTip(m, 'R');
		// Hand near head height and close to it — a real salute, not an outstretched arm.
		expect(hand.y).toBeGreaterThan(head.y - 0.2);
		expect(hand.distanceTo(head)).toBeLessThan(0.35);
		// Left arm stays down at the side.
		expect(handTip(m, 'L').y).toBeLessThan(1.0);
	});

	it('facepalm brings the right hand onto the bowed face', () => {
		const m = new Mannequin({ build: 'male' });
		m.applyPose(getPresetById('facepalm').pose);
		const head = jointWorld(m, 'head');
		const hand = handTip(m, 'R');
		expect(hand.distanceTo(head)).toBeLessThan(0.3);
		// Head is bowed forward (chin down) into the hand.
		expect(m.joints.head.rotation.x).toBeGreaterThan(0.3);
	});

	it('fighting stance raises both fists in front, near head height', () => {
		const m = new Mannequin({ build: 'male' });
		m.applyPose(getPresetById('fighting-stance').pose);
		const head = jointWorld(m, 'head');
		for (const side of ['L', 'R']) {
			const hand = handTip(m, side);
			expect(hand.y, `${side} fist height`).toBeGreaterThan(head.y - 0.25);
			expect(hand.z, `${side} fist forward`).toBeGreaterThan(0.1); // in front of the torso
		}
	});
});

// The auto-rig-on-create gate must agree exactly with the client rig classifier
// (src/shared/rig-classify.js): a usable skeleton is never re-rigged, a confirmed
// static mesh is, and an un-inspected ("unknown") mesh is rigged on creation so
// every avatar that lands ends up animation-ready — the Avaturn-parity contract.

import { describe, it, expect } from 'vitest';
import { rigInfoIsRigged } from '../api/_lib/auto-rig.js';
import { classifyRig } from '../src/shared/rig-classify.js';

describe('rigInfoIsRigged — auto-rig skip gate', () => {
	it('skips when the GLB carries a skeleton flag (e.g. Avaturn export)', () => {
		expect(rigInfoIsRigged({ is_rigged: true })).toBe(true);
	});

	it('skips when a positive joint count is present', () => {
		expect(rigInfoIsRigged({ skeleton_joint_count: 52 })).toBe(true);
		expect(rigInfoIsRigged({ is_rigged: false, skeleton_joint_count: 52 })).toBe(true);
	});

	it('rigs a confirmed static mesh', () => {
		expect(rigInfoIsRigged({ is_rigged: false })).toBe(false);
		expect(rigInfoIsRigged({ is_rigged: false, skeleton_joint_count: 0 })).toBe(false);
	});

	it('rigs an un-inspected (unknown) mesh and a missing signal', () => {
		expect(rigInfoIsRigged(null)).toBe(false);
		expect(rigInfoIsRigged({})).toBe(false);
		expect(rigInfoIsRigged(undefined)).toBe(false);
	});

	// The server gate and the client badge must never disagree about a GLB.
	it('agrees with classifyRig across the signal matrix', () => {
		const cases = [
			{ is_rigged: true },
			{ is_rigged: false },
			{ skeleton_joint_count: 30 },
			{ skeleton_joint_count: 0 },
			{ is_rigged: false, skeleton_joint_count: 12 },
			{},
		];
		for (const meta of cases) {
			const client = classifyRig({ source_meta: meta }).rigged;
			expect(rigInfoIsRigged(meta)).toBe(client);
		}
	});
});

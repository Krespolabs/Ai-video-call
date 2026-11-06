// Tests for the named-empty contract between the authored venue GLB and
// the /club runtime. We don't boot src/club.js here — that pulls in a
// WebGLRenderer + the live DOM — instead we exercise the pure helpers
// in src/club-venue.js against a synthetic three.js scene graph.
//
// The intent is to lock in two guarantees the prompt 01 spec demands:
//   1. When the venue exposes every required empty, the runtime reads
//      stage / backstage / spotlight world positions from those empties
//      instead of the analytical fallback in `POLES`.
//   2. When ANY required empty is missing, the load fails loudly and
//      the error message names which empty is absent — so the artist
//      can fix it in Blender without guessing.

import { describe, it, expect } from 'vitest';
import { Group, Object3D, Vector3 } from 'three';

import {
	REQUIRED_VENUE_EMPTIES,
	collectVenueEmpties,
	resolveVenueAnchors,
} from '../src/club-venue.js';

const POLE_COUNT = 4;

/**
 * Build a synthetic scene that satisfies REQUIRED_VENUE_EMPTIES. Each
 * named empty gets a deterministic world position derived from a small
 * lookup table so the tests can assert on exact coordinates.
 *
 * @param {Set<string>} [omit] — names to skip (used by the sad-path test).
 */
function makeSyntheticVenue(omit = new Set()) {
	const root = new Group();
	root.name = 'venue';

	const positions = {
		truss_mirrorball: [0, 6.0, 0],
		bar_backsplash_neon: [0, 1.6, -7.5],
		stage_01: [-3.5, 0, -3.0],
		stage_02: [-1.2, 0, -4.4],
		stage_03: [1.2, 0, -4.4],
		stage_04: [3.5, 0, -3.0],
		backstage_door_01: [-3.5, 0, -6.8],
		backstage_door_02: [-1.2, 0, -7.2],
		backstage_door_03: [1.2, 0, -7.2],
		backstage_door_04: [3.5, 0, -6.8],
		truss_spot_01: [-3.5, 6.0, -2.5],
		truss_spot_02: [-1.2, 6.0, -4.0],
		truss_spot_03: [1.2, 6.0, -4.0],
		truss_spot_04: [3.5, 6.0, -2.5],
	};

	for (const [name, [x, y, z]] of Object.entries(positions)) {
		if (omit.has(name)) continue;
		const obj = new Object3D();
		obj.name = name;
		obj.position.set(x, y, z);
		root.add(obj);
	}
	root.updateMatrixWorld(true);
	return { root, positions };
}

describe('collectVenueEmpties', () => {
	it('returns a Map keyed by name covering every required empty', () => {
		const { root } = makeSyntheticVenue();
		const empties = collectVenueEmpties(root, REQUIRED_VENUE_EMPTIES);

		expect(empties.size).toBe(REQUIRED_VENUE_EMPTIES.length);
		for (const name of REQUIRED_VENUE_EMPTIES) {
			expect(empties.has(name)).toBe(true);
			expect(empties.get(name).name).toBe(name);
		}
	});

	it('throws naming every missing empty when the venue is incomplete', () => {
		const { root } = makeSyntheticVenue(new Set(['backstage_door_03', 'truss_mirrorball']));
		expect(() => collectVenueEmpties(root, REQUIRED_VENUE_EMPTIES)).toThrow(
			/backstage_door_03/,
		);
		expect(() => collectVenueEmpties(root, REQUIRED_VENUE_EMPTIES)).toThrow(/truss_mirrorball/);
	});

	it('rejects a non-Object3D root with a clear error', () => {
		expect(() => collectVenueEmpties(null)).toThrow(/Object3D/);
		expect(() => collectVenueEmpties({})).toThrow(/Object3D/);
	});

	it('REQUIRED_VENUE_EMPTIES enumerates exactly four of each per-slot empty', () => {
		// Guard against a future edit that drops or adds a pole slot
		// without updating both the contract and the runtime loop.
		const perSlot = REQUIRED_VENUE_EMPTIES.filter((n) => /_\d{2}$/.test(n));
		expect(perSlot.filter((n) => n.startsWith('stage_'))).toHaveLength(POLE_COUNT);
		expect(perSlot.filter((n) => n.startsWith('backstage_door_'))).toHaveLength(POLE_COUNT);
		expect(perSlot.filter((n) => n.startsWith('truss_spot_'))).toHaveLength(POLE_COUNT);
	});
});

describe('resolveVenueAnchors', () => {
	it('reads world positions from the venue empties (not analytical fallback)', () => {
		const { root, positions } = makeSyntheticVenue();
		const empties = collectVenueEmpties(root, REQUIRED_VENUE_EMPTIES);
		const anchors = resolveVenueAnchors(empties, POLE_COUNT);

		expect(anchors.stages).toHaveLength(POLE_COUNT);
		expect(anchors.backstages).toHaveLength(POLE_COUNT);
		expect(anchors.spots).toHaveLength(POLE_COUNT);

		for (let i = 0; i < POLE_COUNT; i += 1) {
			const id = String(i + 1).padStart(2, '0');
			expect(anchors.stages[i]).toBeInstanceOf(Vector3);
			expect(anchors.stages[i].toArray()).toEqual(positions[`stage_${id}`]);
			expect(anchors.backstages[i].toArray()).toEqual(positions[`backstage_door_${id}`]);
			expect(anchors.spots[i].toArray()).toEqual(positions[`truss_spot_${id}`]);
		}
	});

	it('returns the mirrorball + bar-neon anchors as Object3Ds, not Vector3s', () => {
		// Prompt 04 needs to parent the mirror ball / neon strip to these
		// nodes, so the runtime must hand back the live Object3D — not a
		// pre-resolved world-space copy.
		const { root } = makeSyntheticVenue();
		const empties = collectVenueEmpties(root, REQUIRED_VENUE_EMPTIES);
		const anchors = resolveVenueAnchors(empties, POLE_COUNT);

		expect(anchors.mirrorball.name).toBe('truss_mirrorball');
		expect(anchors.barBacksplashNeon.name).toBe('bar_backsplash_neon');
		expect(anchors.mirrorball).toBeInstanceOf(Object3D);
		expect(anchors.barBacksplashNeon).toBeInstanceOf(Object3D);
	});

	it('honors a parent transform when computing world positions', () => {
		// Artists routinely group everything under a `venue` empty in
		// Blender and then translate that group — the runtime needs to see
		// the WORLD position of each slot, not the local one.
		const { root } = makeSyntheticVenue();
		root.position.set(10, 0, -2);
		root.updateMatrixWorld(true);

		const empties = collectVenueEmpties(root, REQUIRED_VENUE_EMPTIES);
		const anchors = resolveVenueAnchors(empties, POLE_COUNT);

		// stage_01 is locally at (-3.5, 0, -3.0); offsetting the parent by
		// (10, 0, -2) puts the world position at (6.5, 0, -5.0).
		expect(anchors.stages[0].toArray()).toEqual([6.5, 0, -5.0]);
	});
});

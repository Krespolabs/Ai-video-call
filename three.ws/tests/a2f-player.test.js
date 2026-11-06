// Tests for the Audio2Face-3D → morph-target mapping + playback layer.
//
// No DOM / no real three.js: we hand A2FPlayer minimal stand-in meshes that
// expose just morphTargetDictionary + morphTargetInfluences (the only surface it
// touches) so vitest can exercise the cross-convention mapping directly. The
// guarantee under test: an A2F ARKit track drives ARKit rigs DIRECTLY and
// VRM/Oculus rigs by DERIVING vowel/viseme activation — with no rig allowlist.

import { describe, it, expect } from 'vitest';
import { A2FPlayer, deriveExpressionWeight } from '../src/voice/a2f-player.js';

// Build a fake Object3D root whose traverse() visits the given meshes.
function makeRoot(meshes) {
	return {
		traverse(cb) {
			cb(this);
			for (const m of meshes) cb(m);
		},
	};
}

function makeMesh(name, morphNames) {
	const dict = {};
	morphNames.forEach((n, i) => (dict[n] = i));
	return {
		isMesh: true,
		name,
		morphTargetDictionary: dict,
		morphTargetInfluences: new Array(morphNames.length).fill(0),
	};
}

// A track with a single column so the index math is obvious.
function jawTrack(values, names = ['JawOpen']) {
	return {
		fps: 30,
		blendShapeNames: names,
		frames: values.map((row, i) => ({ t: i / 30, w: Array.isArray(row) ? row : [row] })),
	};
}

describe('deriveExpressionWeight', () => {
	it('returns the weighted average activation of an expression’s components', () => {
		// VRM "Ou" = { mouthFunnel: 0.7, mouthPucker: 0.4, jawOpen: 0.2 }
		const components = { mouthFunnel: 0.7, mouthPucker: 0.4, jawOpen: 0.2 };
		// Fully-active components → activation 1.0
		expect(deriveExpressionWeight({ mouthFunnel: 1, mouthPucker: 1, jawOpen: 1 }, components)).toBeCloseTo(1, 5);
		// Nothing active → 0
		expect(deriveExpressionWeight({}, components)).toBe(0);
		// Only the dominant component half-active → ~ (0.7*0.5)/1.3
		expect(deriveExpressionWeight({ mouthFunnel: 0.5 }, components)).toBeCloseTo((0.7 * 0.5) / 1.3, 5);
	});

	it('clamps to [0,1]', () => {
		expect(deriveExpressionWeight({ jawOpen: 5 }, { jawOpen: 1 })).toBe(1);
	});
});

describe('A2FPlayer · direct ARKit rig', () => {
	it('writes each A2F shape onto its canonical morph, case/separator-insensitive', () => {
		// Rig spells it "jaw_open"; A2F emits "JawOpen" — both normalize to jawOpen.
		const mesh = makeMesh('Face', ['jaw_open', 'mouthSmileLeft']);
		const player = new A2FPlayer();
		player.attach(makeRoot([mesh]));
		player.setTrack(jawTrack([0, 1]));
		expect(player.hasCoverage()).toBe(true);

		player.update(0);
		expect(mesh.morphTargetInfluences[0]).toBeCloseTo(0, 5);
		player.update(1 / 30); // second frame, JawOpen = 1
		expect(mesh.morphTargetInfluences[0]).toBeCloseTo(1, 5);
	});

	it('interpolates between the 30 fps frames', () => {
		const mesh = makeMesh('Face', ['jawOpen']);
		const player = new A2FPlayer();
		player.attach(makeRoot([mesh]));
		player.setTrack(jawTrack([0, 1])); // frame0 t=0 → 0, frame1 t=1/30 → 1
		player.update(0.5 / 30); // halfway
		expect(mesh.morphTargetInfluences[0]).toBeCloseTo(0.5, 2);
	});

	it('does NOT derive vowel morphs when direct mouth morphs exist', () => {
		// Mesh has both jawOpen (direct) and an "A" morph; the A morph must stay
		// untouched so we never double-stack the lips.
		const mesh = makeMesh('Face', ['jawOpen', 'A']);
		const player = new A2FPlayer();
		player.attach(makeRoot([mesh]));
		player.setTrack(jawTrack([1]));
		player.update(0);
		expect(mesh.morphTargetInfluences[0]).toBeCloseTo(1, 5); // jawOpen driven
		expect(mesh.morphTargetInfluences[1]).toBe(0); // A untouched
	});
});

describe('A2FPlayer · VRM vowel-only rig', () => {
	it('derives the VRM "A" vowel from the A2F JawOpen channel', () => {
		// VRM_TO_ARKIT.A = { jawOpen: 1.0 } → A tracks JawOpen directly.
		const mesh = makeMesh('VRMFace', ['A', 'I', 'O']);
		const player = new A2FPlayer();
		player.attach(makeRoot([mesh]));
		player.setTrack(jawTrack([1])); // JawOpen = 1
		player.update(0);
		expect(mesh.morphTargetInfluences[0]).toBeCloseTo(1, 5); // A
	});
});

describe('A2FPlayer · Oculus viseme rig', () => {
	it('derives viseme_aa from JawOpen', () => {
		// OCULUS_TO_ARKIT.viseme_aa = { jawOpen: 0.95 } → activation 1 at JawOpen=1.
		const mesh = makeMesh('OculusFace', ['viseme_aa', 'viseme_O', 'viseme_PP']);
		const player = new A2FPlayer();
		player.attach(makeRoot([mesh]));
		player.setTrack(jawTrack([1]));
		player.update(0);
		expect(mesh.morphTargetInfluences[0]).toBeCloseTo(1, 5); // viseme_aa
	});
});

describe('A2FPlayer · lifecycle', () => {
	it('reports no coverage for a rig with no recognizable face morphs', () => {
		const mesh = makeMesh('Hair', ['hairWindLeft', 'hairWindRight']);
		const player = new A2FPlayer();
		player.attach(makeRoot([mesh]));
		player.setTrack(jawTrack([1]));
		expect(player.hasCoverage()).toBe(false);
	});

	it('reset settles every bound morph to zero', () => {
		const mesh = makeMesh('Face', ['jawOpen']);
		const player = new A2FPlayer();
		player.attach(makeRoot([mesh]));
		player.setTrack(jawTrack([1]));
		player.update(0);
		expect(mesh.morphTargetInfluences[0]).toBeGreaterThan(0);
		player.reset();
		expect(mesh.morphTargetInfluences[0]).toBe(0);
	});

	it('is a no-op before attach/setTrack', () => {
		const player = new A2FPlayer();
		expect(() => player.update(0)).not.toThrow();
		expect(player.hasCoverage()).toBe(false);
	});
});

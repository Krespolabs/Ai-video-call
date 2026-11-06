/**
 * FaceExpression — the emotional-face applier with morph + brow-bone fallback.
 *
 * Driven with hand-rolled fake Three.js nodes (the real classes aren't needed —
 * the applier only touches morphTargetDictionary/Influences and bone.rotation),
 * matching how the rest of the suite exercises rig code without a renderer.
 */

import { describe, it, expect } from 'vitest';
import { FaceExpression, EXPRESSION_CHANNELS } from '../src/embodiment/face-expression.js';

function morphMesh(names, name = 'Head') {
	const dict = {};
	names.forEach((n, i) => (dict[n] = i));
	return {
		isMesh: true,
		name,
		morphTargetDictionary: dict,
		morphTargetInfluences: new Array(names.length).fill(0),
	};
}
function browBone(name) {
	return { isBone: true, name, rotation: { x: 0, y: 0, z: 0 } };
}
function root(children) {
	return {
		traverse(fn) {
			for (const c of children) fn(c);
		},
	};
}
const settle = (fx, n = 3) => { for (let i = 0; i < n; i++) fx.update(1); };

describe('EXPRESSION_CHANNELS', () => {
	it('is derived from the emotion weight sets and non-empty', () => {
		expect(EXPRESSION_CHANNELS.length).toBeGreaterThan(5);
		expect(EXPRESSION_CHANNELS).toContain('mouthSmileLeft');
		expect(EXPRESSION_CHANNELS).toContain('browDownLeft');
	});
});

describe('FaceExpression — morph mode', () => {
	it('detects morph mode and eases an emotion onto the blendshapes', () => {
		const mesh = morphMesh(['mouthSmileLeft', 'mouthSmileRight', 'browInnerUp', 'cheekSquintLeft', 'cheekSquintRight']);
		const fx = new FaceExpression();
		fx.attach(root([mesh]));
		expect(fx.mode).toBe('morph');

		fx.setEmotion('joy', 1);
		// Before ticking, nothing is applied yet (it eases in).
		expect(mesh.morphTargetInfluences[mesh.morphTargetDictionary.mouthSmileLeft]).toBe(0);
		settle(fx);
		expect(mesh.morphTargetInfluences[mesh.morphTargetDictionary.mouthSmileLeft]).toBeGreaterThan(0.6);
		expect(fx.emotion).toBe('joy');
	});

	it('releases the face back to neutral on clear()', () => {
		const mesh = morphMesh(['mouthSmileLeft', 'mouthSmileRight']);
		const fx = new FaceExpression();
		fx.attach(root([mesh]));
		fx.setEmotion('joy', 1);
		settle(fx);
		fx.clear();
		settle(fx, 8);
		expect(mesh.morphTargetInfluences[mesh.morphTargetDictionary.mouthSmileLeft]).toBeLessThan(0.05);
	});

	it('reduced motion snaps the expression on without ticking', () => {
		const mesh = morphMesh(['mouthSmileLeft', 'mouthSmileRight']);
		const fx = new FaceExpression({ reducedMotion: true });
		fx.attach(root([mesh]));
		fx.setEmotion('joy', 1);
		expect(mesh.morphTargetInfluences[mesh.morphTargetDictionary.mouthSmileLeft]).toBeGreaterThan(0.7);
	});

	it('dispose zeroes the morphs it drove and unbinds', () => {
		const mesh = morphMesh(['mouthSmileLeft', 'mouthSmileRight']);
		const fx = new FaceExpression({ reducedMotion: true });
		fx.attach(root([mesh]));
		fx.setEmotion('joy', 1);
		fx.dispose();
		expect(mesh.morphTargetInfluences[mesh.morphTargetDictionary.mouthSmileLeft]).toBe(0);
		expect(fx.mode).toBe('none');
	});
});

describe('FaceExpression — brow-bone fallback', () => {
	it('raises the brows for surprise and furrows them for anger', () => {
		const mesh = morphMesh(['viseme_aa']); // visemes only — no expression morphs
		const browL = browBone('LeftBrow');
		const browR = browBone('RightBrow');
		const fx = new FaceExpression({ reducedMotion: true });
		fx.attach(root([mesh, browL, browR]));
		expect(fx.mode).toBe('bone');

		fx.setEmotion('surprised', 1); // brows up
		expect(browL.rotation.x).toBeLessThan(0);
		fx.setEmotion('angry', 1); // brows furrowed down
		expect(browL.rotation.x).toBeGreaterThan(0);

		fx.dispose();
		expect(browL.rotation.x).toBe(0); // baseline restored
	});
});

describe('FaceExpression — no facial rig', () => {
	it('reports none mode and no-ops without throwing', () => {
		const mesh = morphMesh([]); // no morphs, no brow bones
		const fx = new FaceExpression();
		fx.attach(root([mesh]));
		expect(fx.mode).toBe('none');
		expect(() => { fx.setEmotion('joy', 1); settle(fx); fx.dispose(); }).not.toThrow();
	});

	it('survives a null root', () => {
		const fx = new FaceExpression();
		expect(() => fx.attach(null)).not.toThrow();
		expect(fx.mode).toBe('none');
	});
});

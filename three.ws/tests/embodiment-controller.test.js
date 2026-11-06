/**
 * EmbodimentController — the glue. Exercised on the text lip-sync lane (the
 * audio lane self-drives via requestAnimationFrame + Web Audio, which the JSDOM
 * test env doesn't provide, so say() falls back to the text envelope here) plus
 * a fake AnimationManager to assert gesture routing.
 */

import { describe, it, expect, vi } from 'vitest';
import { EmbodimentController } from '../src/embodiment/controller.js';

function morphMesh(names) {
	const dict = {};
	names.forEach((n, i) => (dict[n] = i));
	return {
		isMesh: true,
		name: 'Head',
		morphTargetDictionary: dict,
		morphTargetInfluences: new Array(names.length).fill(0),
	};
}
function root(children) {
	return { traverse(fn) { for (const c of children) fn(c); } };
}
function fakeAM() {
	return {
		canPlay: vi.fn(() => true),
		playOnce: vi.fn(),
		crossfadeTo: vi.fn(),
		supportsCanonicalClips: () => true,
	};
}

describe('EmbodimentController — speech (text lane)', () => {
	it('drives the mouth from text and ends on its own', () => {
		const mesh = morphMesh(['jawOpen']);
		const c = new EmbodimentController();
		c.attach(root([mesh]));

		const handle = c.say('aeiou aeiou hello there friend');
		expect(c.speaking).toBe(true);
		expect(handle.duration).toBeGreaterThan(0);

		let opened = false;
		for (let i = 0; i < 20; i++) {
			c.update(0.1);
			if (mesh.morphTargetInfluences[0] > 0.01) opened = true;
		}
		expect(opened).toBe(true);

		// Run well past the end — speech clears itself and shuts the mouth.
		for (let i = 0; i < 400; i++) c.update(0.1);
		expect(c.speaking).toBe(false);
		expect(mesh.morphTargetInfluences[0]).toBe(0);
	});

	it('fires onSpeakEnd when the text envelope completes', () => {
		const onSpeakEnd = vi.fn();
		const c = new EmbodimentController({ onSpeakEnd });
		c.attach(root([morphMesh(['jawOpen'])]));
		c.say('hi');
		for (let i = 0; i < 400; i++) c.update(0.1);
		expect(onSpeakEnd).toHaveBeenCalledTimes(1);
	});

	it('stop() cuts speech early and shuts the mouth', () => {
		const mesh = morphMesh(['jawOpen']);
		const c = new EmbodimentController();
		c.attach(root([mesh]));
		const h = c.say('aeiou aeiou aeiou');
		c.update(0.2);
		h.stop();
		expect(c.speaking).toBe(false);
		expect(mesh.morphTargetInfluences[0]).toBe(0);
	});
});

describe('EmbodimentController — emotion → gesture routing', () => {
	it('plays the high-intensity gesture for strong joy and settles to idle', () => {
		const am = fakeAM();
		const c = new EmbodimentController({ animationManager: am });
		c.attach(root([morphMesh(['mouthSmileLeft', 'mouthSmileRight'])]));
		c.setEmotion('joy', 1);
		expect(am.playOnce).toHaveBeenCalledWith('av-celebrating', { settleTo: 'idle' });
	});

	it('crossfades to idle for neutral (no gesture)', () => {
		const am = fakeAM();
		const c = new EmbodimentController({ animationManager: am });
		c.attach(root([morphMesh(['mouthSmileLeft'])]));
		c.setEmotion('neutral', 1);
		expect(am.playOnce).not.toHaveBeenCalled();
		expect(am.crossfadeTo).toHaveBeenCalledWith('idle');
	});

	it('reduced motion suppresses body gestures but keeps the face', () => {
		const am = fakeAM();
		const mesh = morphMesh(['mouthSmileLeft', 'mouthSmileRight']);
		const c = new EmbodimentController({ animationManager: am, reducedMotion: true });
		c.attach(root([mesh]));
		c.setEmotion('joy', 1);
		expect(am.playOnce).not.toHaveBeenCalled();
		// Face still snapped on (reduced motion = instant, communicative).
		expect(mesh.morphTargetInfluences[mesh.morphTargetDictionary.mouthSmileLeft]).toBeGreaterThan(0.6);
	});

	it('classifies emotion from the spoken line', () => {
		const am = fakeAM();
		const c = new EmbodimentController({ animationManager: am });
		c.attach(root([morphMesh(['mouthSmileLeft', 'mouthSmileRight'])]));
		c.say('Congratulations, this is amazing! 🎉');
		expect(am.playOnce).toHaveBeenCalled(); // a joy gesture was routed
	});
});

describe('EmbodimentController — lifecycle', () => {
	it('reports the rig decision on attach and disposes cleanly', () => {
		const c = new EmbodimentController();
		const rig = c.attach(root([morphMesh(['jawOpen'])]));
		expect(rig.mode).toBeTypeOf('string');
		expect(() => c.dispose()).not.toThrow();
		expect(c.rig).toBe(null);
		expect(c.faceMode).toBe('none');
	});
});

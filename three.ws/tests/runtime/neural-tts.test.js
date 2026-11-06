// Neural TTS lane — unit tests for the pure logic that bridges HeadTTS's viseme
// output to our morph-target driver. The HeadTTS model load + WebGPU audio path
// only runs in a real browser; what's testable in Node is the data mapping
// (Oculus viseme → morph name + timing) and the shared viseme driver's lerp.

import { describe, it, expect } from 'vitest';
import { Mesh, BufferGeometry, Object3D } from 'three';
import { headttsToSequence } from '../../src/runtime/neural-tts.js';
import { activeVisemeAt, createVisemeDriver } from '../../src/runtime/lipsync.js';

// A real HeadTTS `audio` message payload (from its README example).
const HEADTTS_DATA = {
	words: ['This ', 'is ', 'an ', 'example.'],
	wtimes: [440, 656, 876, 1050],
	visemes: ['TH', 'I', 'SS', 'I', 'SS', 'aa', 'nn', 'I', 'kk', 'SS', 'aa', 'PP', 'PP', 'E', 'RR'],
	vtimes: [440, 472, 562, 656, 753, 876, 993, 1050, 1097, 1149, 1200, 1322, 1372, 1423, 1499],
	vdurations: [52, 110, 74, 117, 75, 137, 47, 67, 72, 71, 142, 70, 71, 96, 399],
};

describe('headttsToSequence', () => {
	it('maps Oculus viseme IDs onto viseme_* morph names with start/end times', () => {
		const seq = headttsToSequence(HEADTTS_DATA);
		expect(seq).toHaveLength(HEADTTS_DATA.visemes.length); // no 'sil' in this sample
		expect(seq[0]).toEqual({ viseme: 'viseme_TH', startMs: 440, endMs: 492 });
		expect(seq[5]).toEqual({ viseme: 'viseme_aa', startMs: 876, endMs: 1013 });
		// Every name is one our lipsync driver recognises.
		expect(seq.every((s) => s.viseme.startsWith('viseme_'))).toBe(true);
	});

	it("drops 'sil' (silence) — a gap already renders as a closed mouth", () => {
		const seq = headttsToSequence({ visemes: ['aa', 'sil', 'E'], vtimes: [0, 50, 100], vdurations: [50, 50, 50] });
		expect(seq.map((s) => s.viseme)).toEqual(['viseme_aa', 'viseme_E']);
	});

	it('falls back to an 80ms duration when vdurations is missing', () => {
		const seq = headttsToSequence({ visemes: ['aa'], vtimes: [10] });
		expect(seq[0]).toEqual({ viseme: 'viseme_aa', startMs: 10, endMs: 90 });
	});

	it('returns [] for malformed input', () => {
		expect(headttsToSequence(null)).toEqual([]);
		expect(headttsToSequence({})).toEqual([]);
		expect(headttsToSequence({ visemes: 'nope' })).toEqual([]);
	});
});

describe('activeVisemeAt', () => {
	const seq = headttsToSequence(HEADTTS_DATA);
	it('returns the viseme whose window contains the time', () => {
		expect(activeVisemeAt(seq, 460)).toBe('viseme_TH'); // [440,492)
		expect(activeVisemeAt(seq, 900)).toBe('viseme_aa'); // [876,1013)
	});
	it('returns null before the first and after the last viseme', () => {
		expect(activeVisemeAt(seq, 0)).toBeNull();
		expect(activeVisemeAt(seq, 100000)).toBeNull();
	});

	it('resolves overlapping windows to the earlier-listed viseme (first match wins)', () => {
		// HeadTTS windows overlap (TH [440,492), I [472,582)); 480 is in both.
		expect(activeVisemeAt(seq, 480)).toBe('viseme_TH');
	});
});

describe('createVisemeDriver', () => {
	function avatarWithMorphs(names) {
		const root = new Object3D();
		const mesh = new Mesh(new BufferGeometry());
		mesh.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
		mesh.morphTargetInfluences = names.map(() => 0);
		root.add(mesh);
		return { root, mesh };
	}

	it('lerps the active viseme toward 1 and others toward 0', () => {
		const { root, mesh } = avatarWithMorphs(['viseme_aa', 'viseme_E']);
		const driver = createVisemeDriver(root);
		expect(driver.mode).toBe('arkit');
		for (let i = 0; i < 20; i++) driver.step('viseme_aa');
		expect(mesh.morphTargetInfluences[0]).toBeGreaterThan(0.9); // viseme_aa opened
		expect(mesh.morphTargetInfluences[1]).toBeLessThan(0.1); // viseme_E stayed shut
	});

	it('reset() zeroes every morph', () => {
		const { root, mesh } = avatarWithMorphs(['viseme_aa', 'viseme_E']);
		const driver = createVisemeDriver(root);
		for (let i = 0; i < 10; i++) driver.step('viseme_aa');
		driver.reset();
		expect(mesh.morphTargetInfluences).toEqual([0, 0]);
	});

	it('falls back to jaw-open mode when the rig has only jawOpen', () => {
		const { root, mesh } = avatarWithMorphs(['jawOpen']);
		const driver = createVisemeDriver(root);
		expect(driver.mode).toBe('jaw');
		for (let i = 0; i < 20; i++) driver.step('viseme_aa'); // any active viseme opens the jaw
		expect(mesh.morphTargetInfluences[0]).toBeGreaterThan(0.5);
	});

	it('returns null for an avatar with no mouth morphs', () => {
		expect(createVisemeDriver(new Object3D())).toBeNull();
	});
});

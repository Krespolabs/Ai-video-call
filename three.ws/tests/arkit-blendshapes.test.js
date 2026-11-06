// Tests for the ARKit blendshape vocabulary + cross-format resolver.
//
// Pure data + helpers — no DOM, no three.js — so vitest exercises them
// directly. These guarantees protect downstream lipsync code from silent
// breakage when the upstream maps are tuned.

import { describe, it, expect } from 'vitest';
import {
	ARKIT_NAMES,
	ARKIT_GROUPS,
	VRM_TO_ARKIT,
	OCULUS_TO_ARKIT,
	PHONEME_TO_ARKIT,
	canonicalARKitName,
	indexARKitMorphs,
	coverageOf,
	resolveShape,
	blendShapes,
} from '../src/voice/arkit-blendshapes.js';

describe('ARKit vocabulary', () => {
	it('declares exactly the 52 canonical ARKit names', () => {
		// Apple's published spec: 52 blendshapes covering brow / cheek / eye /
		// jaw / mouth / nose / tongue. Drift from this number means we either
		// dropped one or added a non-standard alias — both are bugs.
		expect(ARKIT_NAMES.length).toBe(52);
	});

	it('has every name unique', () => {
		const set = new Set(ARKIT_NAMES);
		expect(set.size).toBe(ARKIT_NAMES.length);
	});

	it('every group entry is in the canonical list', () => {
		for (const [group, names] of Object.entries(ARKIT_GROUPS)) {
			for (const n of names) {
				expect(ARKIT_NAMES, `${group}.${n} not in canonical list`).toContain(n);
			}
		}
	});

	it('groups partition the full set (no missing, no extras)', () => {
		const fromGroups = new Set(Object.values(ARKIT_GROUPS).flat());
		expect(fromGroups.size).toBe(ARKIT_NAMES.length);
		for (const n of ARKIT_NAMES) {
			expect(fromGroups.has(n), `${n} not assigned to any group`).toBe(true);
		}
	});
});

describe('canonicalARKitName', () => {
	it('returns the canonical spelling for exact-case hits', () => {
		expect(canonicalARKitName('jawOpen')).toBe('jawOpen');
		expect(canonicalARKitName('mouthSmileLeft')).toBe('mouthSmileLeft');
	});

	it('is case-insensitive', () => {
		expect(canonicalARKitName('JAWOPEN')).toBe('jawOpen');
		expect(canonicalARKitName('jawopen')).toBe('jawOpen');
		expect(canonicalARKitName('Jaw_Open')).toBe('jawOpen');
	});

	it('tolerates the common ARKit_ prefix riggers add', () => {
		expect(canonicalARKitName('ARKit_jawOpen')).toBe('jawOpen');
		expect(canonicalARKitName('arkit-jawOpen')).toBe('jawOpen');
	});

	it('tolerates separator variants (_, -, space)', () => {
		expect(canonicalARKitName('mouth_smile_left')).toBe('mouthSmileLeft');
		expect(canonicalARKitName('mouth smile left')).toBe('mouthSmileLeft');
		expect(canonicalARKitName('mouth-smile-left')).toBe('mouthSmileLeft');
	});

	it('returns null for non-ARKit names', () => {
		expect(canonicalARKitName('Aa')).toBeNull(); // VRM, not ARKit
		expect(canonicalARKitName('viseme_aa')).toBeNull(); // Oculus
		expect(canonicalARKitName('totally-made-up')).toBeNull();
		expect(canonicalARKitName('')).toBeNull();
		expect(canonicalARKitName(null)).toBeNull();
	});
});

describe('indexARKitMorphs', () => {
	it('extracts only ARKit-mappable morphs from a morph dict', () => {
		const dict = {
			jawOpen: 0,
			mouthSmileLeft: 1,
			SomeOtherShape: 2,
			ARKit_eyeBlinkLeft: 3,
			'mouth-funnel': 4,
		};
		const idx = indexARKitMorphs(dict);
		expect(idx.get('jawOpen')).toBe(0);
		expect(idx.get('mouthSmileLeft')).toBe(1);
		expect(idx.get('eyeBlinkLeft')).toBe(3);
		expect(idx.get('mouthFunnel')).toBe(4);
		expect(idx.has('SomeOtherShape')).toBe(false);
	});

	it('handles empty / null input', () => {
		expect(indexARKitMorphs(null).size).toBe(0);
		expect(indexARKitMorphs({}).size).toBe(0);
	});

	it('first occurrence wins on duplicate canonical mapping', () => {
		const dict = { jawOpen: 5, jaw_open: 9 };
		const idx = indexARKitMorphs(dict);
		// Iteration order of Object.entries is insertion order, so 5 wins.
		expect(idx.get('jawOpen')).toBe(5);
	});
});

describe('coverageOf', () => {
	it('reports per-group presence + overall ratio', () => {
		// Construct an index missing the entire eye group.
		const dict = Object.fromEntries(
			ARKIT_NAMES.filter((n) => !ARKIT_GROUPS.eye.includes(n)).map((n, i) => [n, i]),
		);
		const idx = indexARKitMorphs(dict);
		const c = coverageOf(idx);
		expect(c.eye.present).toBe(0);
		expect(c.eye.missing.length).toBe(ARKIT_GROUPS.eye.length);
		expect(c.jaw.present).toBe(ARKIT_GROUPS.jaw.length);
		expect(c.overall.present).toBe(ARKIT_NAMES.length - ARKIT_GROUPS.eye.length);
		expect(c.overall.ratio).toBeGreaterThan(0.5);
		expect(c.overall.ratio).toBeLessThan(1);
	});
});

describe('resolveShape', () => {
	it('returns a single-key map for direct ARKit hits', () => {
		expect(resolveShape('jawOpen')).toEqual({ jawOpen: 1 });
		expect(resolveShape('JAW_OPEN')).toEqual({ jawOpen: 1 });
	});

	it('expands VRM expressions to weighted ARKit maps', () => {
		const r = resolveShape('Aa');
		expect(r.jawOpen).toBe(1.0);
	});

	it('expands Oculus visemes', () => {
		const r = resolveShape('viseme_O');
		expect(r.jawOpen).toBeGreaterThan(0);
		expect(r.mouthFunnel).toBeGreaterThan(0);
	});

	it('expands Preston-Blair phoneme codes', () => {
		const r = resolveShape('MBP');
		expect(r.mouthClose).toBeGreaterThan(0.8);
	});

	it('returns empty for unknown inputs', () => {
		expect(resolveShape('completely-unknown')).toEqual({});
		expect(resolveShape('')).toEqual({});
		expect(resolveShape(null)).toEqual({});
	});

	it('every weighted map value is in [0, 1]', () => {
		const maps = [VRM_TO_ARKIT, OCULUS_TO_ARKIT, PHONEME_TO_ARKIT];
		for (const map of maps) {
			for (const [shape, weights] of Object.entries(map)) {
				for (const [k, v] of Object.entries(weights)) {
					expect(v, `${shape}.${k} out of range`).toBeGreaterThanOrEqual(0);
					expect(v, `${shape}.${k} out of range`).toBeLessThanOrEqual(1);
				}
			}
		}
	});

	it('every weighted map references only canonical ARKit names', () => {
		const maps = [VRM_TO_ARKIT, OCULUS_TO_ARKIT, PHONEME_TO_ARKIT];
		for (const map of maps) {
			for (const [shape, weights] of Object.entries(map)) {
				for (const k of Object.keys(weights)) {
					expect(canonicalARKitName(k), `${shape} → ${k} not ARKit`).toBe(k);
				}
			}
		}
	});
});

describe('blendShapes', () => {
	it('merges shape inputs with max-per-channel', () => {
		const out = blendShapes('jawOpen', { jawOpen: 0.4, mouthSmileLeft: 0.5 });
		// Direct ARKit hit gives jawOpen: 1; the explicit 0.4 doesn't lower it.
		expect(out.jawOpen).toBe(1);
		expect(out.mouthSmileLeft).toBe(0.5);
	});

	it('canonicalizes non-canonical keys in raw input maps', () => {
		const out = blendShapes({ Jaw_Open: 0.6 });
		expect(out.jawOpen).toBeCloseTo(0.6);
	});

	it('drops unknown shape names silently', () => {
		const out = blendShapes({ unknownShape: 0.9 });
		expect(out).toEqual({});
	});

	it('clamps out-of-range weights', () => {
		const out = blendShapes({ jawOpen: 2.5 });
		expect(out.jawOpen).toBe(1);
		const out2 = blendShapes({ jawOpen: -1 });
		expect(out2.jawOpen).toBeUndefined(); // 0 wouldn't beat undefined (default 0)
	});

	it('blends a VRM emotion onto a phoneme cleanly', () => {
		// Speaking with a smile: phoneme E + VRM Joy.
		const out = blendShapes('E', 'Joy');
		expect(out.mouthSmileLeft).toBeGreaterThan(0);
		expect(out.jawOpen).toBeGreaterThan(0);
		expect(out.cheekSquintLeft).toBeGreaterThan(0); // from Joy
	});
});

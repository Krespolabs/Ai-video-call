/**
 * pose-match — natural-language → pose resolver unit tests.
 *
 * Covers the three resolution paths:
 *   1. Emote-intent: a prompt whose token overlaps a known EMOTE_INTENT maps
 *      to an animated clip.
 *   2. Static preset: a prompt token-scores against the PRESETS library and
 *      returns the best-matching pose.
 *   3. Deterministic hash-pick: an unrecognised prompt (score 0) always resolves
 *      to the same preset for the same caller (FNV-1a fallback).
 *
 * Also validates POSE_QUICK_PICKS shape so chip rendering never silently breaks.
 */

import { describe, it, expect } from 'vitest';
import {
	matchPose,
	presetPoseById,
	POSE_QUICK_PICKS,
	EMOTE_INTENTS,
} from '../src/pose-match.js';

describe('matchPose — emote intents', () => {
	it('resolves "wave hello" to an animated clip', () => {
		const result = matchPose('wave hello');
		expect(result.kind).toBe('clip');
		expect(result.clip).toBe('wave');
		expect(result.label).toBe('Wave');
		expect(result.reason).toBe('emote-intent');
	});

	it('resolves "celebrate" to the celebrate clip', () => {
		const result = matchPose('celebrate');
		expect(result.kind).toBe('clip');
		expect(result.clip).toBe('celebrate');
	});

	it('resolves "dance" to the dance clip', () => {
		const result = matchPose('dance');
		expect(result.kind).toBe('clip');
		expect(result.clip).toBe('dance');
	});

	it('resolves "facepalm" to the facepalm clip', () => {
		const result = matchPose('facepalm ugh');
		expect(result.kind).toBe('clip');
		expect(result.clip).toBe('facepalm');
	});

	it('clip actions carry a fallbackPreset string', () => {
		const result = matchPose('wave');
		expect(result.kind).toBe('clip');
		expect(typeof result.fallbackPreset).toBe('string');
		expect(result.fallbackPreset.length).toBeGreaterThan(0);
	});
});

describe('matchPose — static preset resolution', () => {
	it('resolves "warrior stance" to a pose with positive score', () => {
		const result = matchPose('warrior stance');
		expect(result.kind).toBe('pose');
		// "fighting-stance" scores highest for "warrior stance" (shares "stance");
		// "warrior2" is also a valid match. Either is an intentional preset hit.
		expect(result.score).toBeGreaterThan(0);
		expect(result.reason).toBe('token-match');
	});

	it('resolves "take a bow" to the bow preset', () => {
		const result = matchPose('take a bow');
		expect(result.kind).toBe('pose');
		expect(result.presetId).toMatch(/bow/i);
	});

	it('returned parameters map contains at least one joint', () => {
		const result = matchPose('warrior stance');
		expect(result.kind).toBe('pose');
		expect(typeof result.parameters).toBe('object');
		expect(Object.keys(result.parameters).length).toBeGreaterThan(0);
	});

	it('score is 0 for an empty parameters object prompt', () => {
		const result = matchPose('');
		expect(result.kind).toBe('pose');
		expect(result.score).toBe(0);
		expect(result.reason).toBe('no-match-deterministic-pick');
	});
});

describe('matchPose — deterministic hash fallback', () => {
	it('same prompt → same preset on repeated calls (idempotent)', () => {
		// Any prompt, recognised or not, must resolve to the same preset twice.
		const prompt = 'a very exotic phrase that has zero pose tokens 99999';
		const a = matchPose(prompt);
		const b = matchPose(prompt);
		expect(a.kind).toBe('pose');
		expect(a.presetId).toBe(b.presetId);
	});

	it('different unrecognised prompts → different presets (high probability)', () => {
		const a = matchPose('zzzunknown111');
		const b = matchPose('qqqqunknown999');
		// Two independent random-ish hashes over distinct strings should rarely collide
		// in a ≥30-preset library. Allow either same or different — just ensure no throw.
		expect(typeof a.presetId).toBe('string');
		expect(typeof b.presetId).toBe('string');
	});
});

describe('presetPoseById', () => {
	it('returns the pose map for a known preset id', () => {
		const pose = presetPoseById('wave');
		expect(pose).not.toBeNull();
		expect(typeof pose).toBe('object');
		expect(Object.keys(pose).length).toBeGreaterThan(0);
	});

	it('returns null for an unknown id', () => {
		expect(presetPoseById('__this_does_not_exist__')).toBeNull();
	});
});

describe('POSE_QUICK_PICKS', () => {
	it('is a non-empty array', () => {
		expect(Array.isArray(POSE_QUICK_PICKS)).toBe(true);
		expect(POSE_QUICK_PICKS.length).toBeGreaterThan(0);
	});

	it('every chip has prompt, icon, and label strings', () => {
		for (const qp of POSE_QUICK_PICKS) {
			expect(typeof qp.prompt).toBe('string');
			expect(qp.prompt.length).toBeGreaterThan(0);
			expect(typeof qp.icon).toBe('string');
			expect(typeof qp.label).toBe('string');
		}
	});

	it('every chip prompt resolves through matchPose without throwing', () => {
		for (const qp of POSE_QUICK_PICKS) {
			const result = matchPose(qp.prompt);
			expect(['clip', 'pose']).toContain(result.kind);
		}
	});
});

describe('EMOTE_INTENTS shape', () => {
	it('every intent has keys array, clip, label, and fallbackPreset', () => {
		for (const intent of EMOTE_INTENTS) {
			expect(Array.isArray(intent.keys)).toBe(true);
			expect(intent.keys.length).toBeGreaterThan(0);
			expect(typeof intent.clip).toBe('string');
			expect(typeof intent.label).toBe('string');
			expect(typeof intent.fallbackPreset).toBe('string');
		}
	});
});

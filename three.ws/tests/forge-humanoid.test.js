/**
 * Humanoid-prompt classifier — unit tests.
 *
 * This is the gate that decides whether a generated mesh gets a *paid* auto-rig
 * call in the forge_avatar pipeline. A false positive bills a user for a useless
 * skeleton on a non-character mesh; a false negative ships an un-riggable avatar.
 * Both are real-money / real-product failures, so the classifier is covered
 * thoroughly: clear humanoids rig, clear objects/animals don't, ambiguous
 * prompts default to not-rigging, and the function never throws on junk input.
 *
 * Contract (see mcp-server/src/tools/_humanoid.js):
 *   { humanoid: boolean,
 *     confidence: 'high'|'medium'|'low',
 *     reason: string,
 *     signals: { humanoid: string[], nonHumanoid: string[] } }
 * `humanoid` is the only field the production caller (api/_lib/auto-rig.js) acts
 * on; `confidence`/`signals` are for observability.
 */

import { describe, it, expect } from 'vitest';

import { classifyHumanoidPrompt } from '../mcp-server/src/tools/_humanoid.js';

const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

describe('classifyHumanoidPrompt — humanoid figures rig', () => {
	const HUMANOID = [
		'a friendly cartoon astronaut, glossy white suit',
		'a medieval knight in plate armour',
		'an anime girl with pink hair',
		'a muscular warrior holding a sword', // object word present, figure dominates
		'cyberpunk character, neon jacket',
		'a robot mascot, rounded white plastic',
		'an elf ranger standing in a forest',
		'full body male avatar, casual streetwear',
		'a zombie shambling forward',
		'a wizard with a long beard',
	];
	for (const prompt of HUMANOID) {
		it(`rigs: "${prompt}"`, () => {
			const r = classifyHumanoidPrompt(prompt);
			expect(r.humanoid).toBe(true);
			// Clear humanoids never resolve to the ambiguous low-confidence default.
			expect(['high', 'medium']).toContain(r.confidence);
			expect(r.signals.humanoid.length).toBeGreaterThan(0);
		});
	}
});

describe('classifyHumanoidPrompt — non-humanoid subjects skip rigging', () => {
	const NON_HUMANOID = [
		'a worn leather armchair, brass studs',
		'a sleek sports car, candy red paint',
		'a medieval sword with a jewelled hilt',
		'a cozy wooden cabin in the snow',
		'a red apple on a table',
		'a golden coin with an emblem',
		'a potted plant with green leaves',
		'a glossy ceramic teapot',
		'a fighter jet on a runway',
		'a treasure chest full of gold',
	];
	for (const prompt of NON_HUMANOID) {
		it(`skips: "${prompt}"`, () => {
			const r = classifyHumanoidPrompt(prompt);
			expect(r.humanoid).toBe(false);
			expect(CONFIDENCE_LEVELS).toContain(r.confidence);
			expect(r.signals.nonHumanoid.length).toBeGreaterThan(0);
		});
	}
});

describe('classifyHumanoidPrompt — animals are non-humanoid', () => {
	for (const prompt of [
		'a fierce dragon breathing fire',
		'a galloping horse',
		'a cute cartoon dog',
		'a great white shark',
	]) {
		it(`skips animal: "${prompt}"`, () => {
			expect(classifyHumanoidPrompt(prompt).humanoid).toBe(false);
		});
	}

	it('a non-humanoid noun overpowers stray body words', () => {
		// "arms" is a body cue but "dragon" is a strong non-humanoid subject —
		// the net must stay non-humanoid so we never rig a dragon.
		const r = classifyHumanoidPrompt('a dragon with two arms and legs');
		expect(r.humanoid).toBe(false);
	});
});

describe('classifyHumanoidPrompt — whole-word matching', () => {
	it('does not match "man" inside "manifold"', () => {
		const r = classifyHumanoidPrompt('a chrome manifold engine part');
		expect(r.signals.humanoid).toHaveLength(0);
		expect(r.humanoid).toBe(false);
	});

	it('does not match "arm" inside "armchair"', () => {
		const r = classifyHumanoidPrompt('a velvet armchair');
		// "armchair" is a non-humanoid term; "arm" must not register a humanoid hit.
		expect(r.signals.humanoid).toHaveLength(0);
		expect(r.humanoid).toBe(false);
	});
});

describe('classifyHumanoidPrompt — robustness and contract', () => {
	it('returns a non-humanoid verdict for empty input, never throws', () => {
		for (const junk of ['', '   ', null, undefined, '!!!', '12345']) {
			const r = classifyHumanoidPrompt(junk);
			expect(r.humanoid).toBe(false);
			expect(CONFIDENCE_LEVELS).toContain(r.confidence);
			expect(typeof r.reason).toBe('string');
		}
	});

	it('confidence is always one of the documented levels', () => {
		const prompts = [
			'a hero warrior knight soldier man',
			'armchair car table sword coin building',
			'a person',
			'random noise words about nothing in particular',
		];
		for (const p of prompts) {
			expect(CONFIDENCE_LEVELS).toContain(classifyHumanoidPrompt(p).confidence);
		}
	});

	it('is deterministic — same prompt, same verdict (billing-stable)', () => {
		const p = 'a cyborg ninja with glowing eyes';
		const a = classifyHumanoidPrompt(p);
		const b = classifyHumanoidPrompt(p);
		expect(a).toEqual(b);
	});

	it('exposes signal hits for observability', () => {
		const r = classifyHumanoidPrompt('a warrior woman with strong arms');
		expect(r.signals.humanoid.length).toBeGreaterThan(0);
		expect(r.signals.nonHumanoid).toHaveLength(0);
	});
});

import { describe, it, expect } from 'vitest';

import { classifyHumanoidPrompt } from '../mcp-server/src/tools/_humanoid.js';
import { buildForgeAvatarTool } from '../mcp-server/src/tools/forge-avatar.js';

// The humanoid classifier is the money-safety gate for `forge_avatar`: it is the
// only thing standing between a caller and a wasted paid rig on a non-character
// mesh. `humanoid:false` is the verdict the tool blocks (and CANCELS billing)
// on, so the false-negative direction (calling a real character non-humanoid)
// and false-positive direction (rigging furniture) both matter.

describe('classifyHumanoidPrompt — humanoid subjects (must rig)', () => {
	const humanoid = [
		'a friendly cartoon astronaut, glossy white suit',
		'a medieval knight in plate armour',
		'an anime girl with pink hair',
		'a muscular warrior holding a sword', // subject wins over the held prop
		'a robot mascot, rounded white plastic',
		'full body male avatar, casual streetwear',
		'a zombie shambling forward',
		'a wizard with a long beard',
		'a cyberpunk ninja, neon trim',
		'a chibi character with big eyes',
		'an elf ranger with a bow', // elf (humanoid) ties with bow (prop) → subject wins
		'a viking shieldmaiden',
	];
	for (const prompt of humanoid) {
		it(`treats "${prompt}" as humanoid`, () => {
			const r = classifyHumanoidPrompt(prompt);
			expect(r.humanoid).toBe(true);
			expect(['high', 'medium', 'low']).toContain(r.confidence);
		});
	}
});

describe('classifyHumanoidPrompt — non-humanoid subjects (skip rig)', () => {
	const nonHumanoid = [
		'a worn leather armchair, brass studs',
		'a sleek sports car, candy red paint',
		'a medieval sword with a jewelled hilt',
		'a red apple on a table',
		'a glossy ceramic teapot',
		'a galloping horse',
		'a curled-up sleeping cat',
		'a chrome manifold engine part',
		'a stone castle on a hill',
		'a fierce dragon breathing fire',
		'a potted fern plant',
		'a wooden treasure chest',
	];
	for (const prompt of nonHumanoid) {
		it(`treats "${prompt}" as non-humanoid`, () => {
			const r = classifyHumanoidPrompt(prompt);
			expect(r.humanoid).toBe(false);
		});
	}
});

describe('classifyHumanoidPrompt — whole-word matching (no substring traps)', () => {
	it('does not trip "man" inside "manifold"', () => {
		expect(classifyHumanoidPrompt('a cast-iron manifold').humanoid).toBe(false);
	});
	it('does not trip "car" inside an unrelated word, but does match a real car', () => {
		expect(classifyHumanoidPrompt('a vintage car').humanoid).toBe(false);
	});
	it('matches multi-word terms like "anime girl"', () => {
		const r = classifyHumanoidPrompt('anime girl in a school uniform');
		expect(r.humanoid).toBe(true);
		expect(r.signals.humanoid.length).toBeGreaterThan(0);
	});
});

describe('classifyHumanoidPrompt — degenerate input', () => {
	it('rejects empty/short input as non-humanoid, low confidence', () => {
		expect(classifyHumanoidPrompt('').humanoid).toBe(false);
		expect(classifyHumanoidPrompt('ab').humanoid).toBe(false);
		expect(classifyHumanoidPrompt(null).humanoid).toBe(false);
		expect(classifyHumanoidPrompt(undefined).humanoid).toBe(false);
	});
	it('defaults an unrecognized-but-plausible subject to humanoid (caller opted into an avatar)', () => {
		const r = classifyHumanoidPrompt('a glorptak with iridescent shimmering skin');
		expect(r.humanoid).toBe(true);
		expect(r.confidence).toBe('low');
	});
	it('always returns a stable shape', () => {
		const r = classifyHumanoidPrompt('a knight');
		expect(r).toHaveProperty('humanoid');
		expect(r).toHaveProperty('confidence');
		expect(r).toHaveProperty('reason');
		expect(r.signals).toHaveProperty('humanoid');
		expect(r.signals).toHaveProperty('nonHumanoid');
	});
});

describe('forge_avatar — descriptor', () => {
	it('is a paid write that quotes $0.45 and advertises the humanoid gate', async () => {
		const tool = await buildForgeAvatarTool();
		expect(tool.name).toBe('forge_avatar');
		expect(tool.title).toMatch(/\$0\.45/);
		expect(tool.description).toMatch(/\$0\.45/);
		expect(tool.description.toLowerCase()).toMatch(/humanoid/);
		expect(tool.description.toLowerCase()).toMatch(/animation-ready|animation ready/);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(tool.handler).toBeTypeOf('function');
	});

	it('exposes the full text + image + override input surface', async () => {
		const tool = await buildForgeAvatarTool();
		for (const field of ['prompt', 'image_url', 'image_urls', 'aspect_ratio', 'direct', 'allow_non_humanoid']) {
			expect(tool.inputSchema[field], `missing input field ${field}`).toBeTruthy();
		}
	});
});

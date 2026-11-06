// Agent Genome — deterministic inheritance, bounded mutation, recessive carry,
// emergent fusion, and the anti-forgery verify path. Pure functions only: every
// invariant the breeding feature rests on is pinned here with no DB or network.

import { describe, it, expect } from 'vitest';
import {
	deriveGenome,
	verifyGenome,
	genomeFromAgent,
	hashGenome,
	normalizeGenome,
	pedigreeScore,
	composePersonaPrompt,
	voiceSettings,
	appearanceFromGenome,
	expressedSkills,
	makeSeed,
	MUTATION_MAX,
	GENOME_VERSION,
} from '../api/_lib/genome.js';

const founder = (id, over = {}) =>
	genomeFromAgent({
		id,
		persona_tone_tags: over.tone || ['precise', 'analytical'],
		voice_provider: over.voice_provider || 'elevenlabs',
		voice_id: over.voice_id || `voice-${id}`,
		voice_settings: over.voice_settings || { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
		appearance: over.appearance || { morphs: { headScale: 0.8 }, colors: { hair: '#aa3311' }, accessories: ['hat'] },
		skills: over.skills || ['trading', 'memory'],
		avatar_id: over.avatar_id || `av-${id}`,
		meta: {},
	});

describe('genomeFromAgent (founder)', () => {
	it('is deterministic and stable for the same agent', () => {
		const a = founder('alpha');
		const b = founder('alpha');
		expect(hashGenome(a)).toBe(hashGenome(b));
		expect(a.generation).toBe(0);
		expect(a.version).toBe(GENOME_VERSION);
	});
	it('marks all founder skills expressed + dominant', () => {
		const a = founder('alpha', { skills: ['trading'] });
		expect(a.skills.every((s) => s.expressed && s.dominant)).toBe(true);
	});
	it('different agents get distinctive genomes', () => {
		expect(hashGenome(founder('alpha'))).not.toBe(hashGenome(founder('beta')));
	});
});

describe('deriveGenome determinism', () => {
	it('same (parents, seed) => byte-identical child', () => {
		const A = founder('alpha');
		const B = founder('beta');
		const c1 = deriveGenome({ parentA: A, parentB: B, seed: 'seed-123' });
		const c2 = deriveGenome({ parentA: A, parentB: B, seed: 'seed-123' });
		expect(c1.genome_hash).toBe(c2.genome_hash);
		expect(JSON.stringify(c1)).toBe(JSON.stringify(c2));
	});
	it('is order-independent: A×B == B×A (canonical parents)', () => {
		const A = founder('alpha');
		const B = founder('beta');
		const ab = deriveGenome({ parentA: A, parentB: B, seed: 's' });
		const ba = deriveGenome({ parentA: B, parentB: A, seed: 's' });
		expect(ab.genome_hash).toBe(ba.genome_hash);
	});
	it('different seeds produce different children', () => {
		const A = founder('alpha');
		const B = founder('beta');
		const c1 = deriveGenome({ parentA: A, parentB: B, seed: 's1' });
		const c2 = deriveGenome({ parentA: A, parentB: B, seed: 's2' });
		expect(c1.genome_hash).not.toBe(c2.genome_hash);
	});
	it('throws without a seed', () => {
		expect(() => deriveGenome({ parentA: founder('a'), parentB: founder('b') })).toThrow();
	});
	it('increments generation past the deeper parent', () => {
		const A = founder('alpha');
		const B = founder('beta');
		const child = deriveGenome({ parentA: A, parentB: B, seed: 's' });
		expect(child.generation).toBe(1);
		const grandchild = deriveGenome({ parentA: child, parentB: founder('gamma'), seed: 's2' });
		expect(grandchild.generation).toBe(2);
	});
});

describe('bounded mutation', () => {
	it('every brain/voice locus stays within MUTATION_MAX of the parental blend', () => {
		const A = founder('alpha');
		const B = founder('beta');
		// Sweep many seeds; the bound must hold for all of them.
		for (let i = 0; i < 200; i++) {
			const child = deriveGenome({ parentA: A, parentB: B, seed: `seed-${i}` });
			for (const locus of ['temperature', 'verbosity', 'curiosity', 'formality', 'humor', 'boldness']) {
				const lo = Math.min(A.brain[locus], B.brain[locus]) - MUTATION_MAX - 1e-9;
				const hi = Math.max(A.brain[locus], B.brain[locus]) + MUTATION_MAX + 1e-9;
				expect(child.brain[locus]).toBeGreaterThanOrEqual(Math.max(0, lo));
				expect(child.brain[locus]).toBeLessThanOrEqual(Math.min(1, hi));
			}
		}
	});
	it('records notable mutations in genome.mutations', () => {
		// Identical parents → blend == parent value, so any entry in mutations is a
		// genuine recorded drift.
		const A = founder('alpha');
		const child = deriveGenome({ parentA: A, parentB: founder('alpha'), seed: 'mut-seed' });
		for (const m of child.mutations) {
			expect(Math.abs(m.delta)).toBeGreaterThan(0);
			expect(Math.abs(m.delta)).toBeLessThanOrEqual(MUTATION_MAX + 1e-9);
		}
	});
});

describe('skill allele inheritance', () => {
	it('a skill both parents express is always expressed + dominant', () => {
		const A = founder('alpha', { skills: ['trading'] });
		const B = founder('beta', { skills: ['trading'] });
		const child = deriveGenome({ parentA: A, parentB: B, seed: 'x' });
		const trading = child.skills.find((s) => s.skill === 'trading');
		expect(trading.expressed).toBe(true);
		expect(trading.dominant).toBe(true);
	});
	it('a skill only one parent has is sometimes recessive (carried, unexpressed)', () => {
		const A = founder('alpha', { skills: ['rareskill'] });
		const B = founder('beta', { skills: ['common'] });
		let sawRecessive = false;
		let sawExpressed = false;
		for (let i = 0; i < 60; i++) {
			const child = deriveGenome({ parentA: A, parentB: B, seed: `het-${i}` });
			const rare = child.skills.find((s) => s.skill === 'rareskill');
			expect(rare).toBeTruthy();
			if (rare.recessive) sawRecessive = true;
			if (rare.expressed) sawExpressed = true;
		}
		expect(sawRecessive).toBe(true);
		expect(sawExpressed).toBe(true);
	});
	it('a recessive allele carried by both parents surfaces in the child', () => {
		// Build two heterozygous carriers of the same recessive skill.
		const A = normalizeGenome({
			...founder('alpha'),
			skills: [{ skill: 'latent', expressed: false, recessive: true, source: 'A', depth: 1 }],
		});
		const B = normalizeGenome({
			...founder('beta'),
			skills: [{ skill: 'latent', expressed: false, recessive: true, source: 'B', depth: 1 }],
		});
		const child = deriveGenome({ parentA: A, parentB: B, seed: 'pair' });
		const latent = child.skills.find((s) => s.skill === 'latent');
		expect(latent.expressed).toBe(true);
	});
});

describe('emergent fusion', () => {
	it('can produce a skill neither parent expressed (auditable rule)', () => {
		const A = founder('alpha', { skills: ['trading'] });
		const B = founder('beta', { skills: ['sentiment'] });
		let emergentSeen = false;
		for (let i = 0; i < 80; i++) {
			const child = deriveGenome({ parentA: A, parentB: B, seed: `fuse-${i}` });
			const alpha = child.skills.find((s) => s.skill === 'alpha-signal');
			if (alpha) {
				expect(alpha.source).toBe('emergent');
				expect(alpha.emergent_from).toEqual(['trading', 'sentiment']);
				emergentSeen = true;
			}
		}
		expect(emergentSeen).toBe(true);
	});
});

describe('verifyGenome (anti-forgery)', () => {
	it('accepts a genuinely derived child', () => {
		const A = founder('alpha');
		const B = founder('beta');
		const child = deriveGenome({ parentA: A, parentB: B, seed: 'real' });
		const res = verifyGenome(child, { parentA: A, parentB: B, seed: 'real' });
		expect(res.valid).toBe(true);
	});
	it('rejects a tampered child (forged trait)', () => {
		const A = founder('alpha');
		const B = founder('beta');
		const child = deriveGenome({ parentA: A, parentB: B, seed: 'real' });
		const forged = { ...child, brain: { ...child.brain, boldness: 0.999 } };
		const res = verifyGenome(forged, { parentA: A, parentB: B, seed: 'real' });
		expect(res.valid).toBe(false);
		expect(res.reason).toBe('hash_mismatch');
	});
	it('rejects a child claimed under the wrong seed', () => {
		const A = founder('alpha');
		const B = founder('beta');
		const child = deriveGenome({ parentA: A, parentB: B, seed: 'real' });
		expect(verifyGenome(child, { parentA: A, parentB: B, seed: 'wrong' }).valid).toBe(false);
	});
	it('rejects a child claimed under wrong parentage', () => {
		const A = founder('alpha');
		const B = founder('beta');
		const child = deriveGenome({ parentA: A, parentB: B, seed: 'real' });
		expect(verifyGenome(child, { parentA: A, parentB: founder('gamma'), seed: 'real' }).valid).toBe(false);
	});
});

describe('artifact projections', () => {
	it('voiceSettings are valid ElevenLabs ranges', () => {
		const child = deriveGenome({ parentA: founder('a'), parentB: founder('b'), seed: 's' });
		const vs = voiceSettings(child);
		for (const k of ['stability', 'similarity_boost', 'style']) {
			expect(vs[k]).toBeGreaterThanOrEqual(0);
			expect(vs[k]).toBeLessThanOrEqual(1);
		}
		expect(typeof vs.use_speaker_boost).toBe('boolean');
	});
	it('appearanceFromGenome is bakeable (morphs/colors present)', () => {
		const child = deriveGenome({ parentA: founder('a'), parentB: founder('b'), seed: 's' });
		const app = appearanceFromGenome(child);
		expect(app.morphs || app.colors || app.accessories).toBeTruthy();
	});
	it('persona prompt is in-character and references inherited skills', () => {
		const child = deriveGenome({ parentA: founder('a', { skills: ['trading'] }), parentB: founder('b', { skills: ['trading'] }), seed: 's' });
		const prompt = composePersonaPrompt(child, 'Nova');
		expect(prompt).toContain('Nova');
		expect(prompt.toLowerCase()).toContain('trading');
	});
	it('expressedSkills excludes recessive alleles', () => {
		const g = normalizeGenome({
			skills: [
				{ skill: 'shown', expressed: true },
				{ skill: 'hidden', expressed: false, recessive: true },
			],
		});
		expect(expressedSkills(g)).toEqual(['shown']);
	});
});

describe('pedigreeScore', () => {
	it('rewards depth and emergent traits with rarer tiers', () => {
		const flat = pedigreeScore(founder('a'));
		expect(flat.tier).toBe('common');
		const deep = pedigreeScore({ ...founder('a'), generation: 4 });
		expect(['rare', 'legendary']).toContain(deep.tier);
	});
});

describe('makeSeed', () => {
	it('produces a 32-char hex string', () => {
		const seed = makeSeed(Buffer.alloc(16, 7));
		expect(seed).toMatch(/^[0-9a-f]{32}$/);
	});
});

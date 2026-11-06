import { describe, it, expect } from 'vitest';
import {
	PERSONA_TRAITS,
	PERSONA_TRAIT_KEYS,
	DEFAULT_TRAIT_VALUE,
	bandIndex,
	defaultTraitValues,
	clampTraits,
	describeTrait,
	compilePersona,
	registerSummary,
	sanitizeToneTags,
	sanitizeVocabulary,
} from './persona-compile.js';

describe('persona trait model', () => {
	it('exposes seven editable dimensions with three bands each', () => {
		expect(PERSONA_TRAITS).toHaveLength(7);
		expect(PERSONA_TRAIT_KEYS).toContain('warmth');
		for (const t of PERSONA_TRAITS) {
			expect(t.bands).toHaveLength(3);
			expect(typeof t.label).toBe('string');
		}
	});

	it('defaults every trait to the mid value', () => {
		const d = defaultTraitValues();
		expect(Object.keys(d).sort()).toEqual([...PERSONA_TRAIT_KEYS].sort());
		for (const v of Object.values(d)) expect(v).toBe(DEFAULT_TRAIT_VALUE);
	});

	it('bands split low / mid / high', () => {
		expect(bandIndex(0)).toBe(0);
		expect(bandIndex(0.2)).toBe(0);
		expect(bandIndex(0.5)).toBe(1);
		expect(bandIndex(0.9)).toBe(2);
		expect(bandIndex(1)).toBe(2);
	});

	it('clamps out-of-range and unknown trait input', () => {
		const c = clampTraits({ warmth: 5, formality: -3, bogus: 0.4 });
		expect(c.warmth).toBe(1);
		expect(c.formality).toBe(0);
		expect(c).not.toHaveProperty('bogus');
		expect(c.humor).toBe(DEFAULT_TRAIT_VALUE); // missing → default
	});

	it('handles non-finite and missing input gracefully', () => {
		const c = clampTraits({ warmth: NaN, formality: 'x', verbosity: undefined });
		expect(c.warmth).toBe(DEFAULT_TRAIT_VALUE);
		expect(c.formality).toBe(DEFAULT_TRAIT_VALUE);
		expect(clampTraits(null).humor).toBe(DEFAULT_TRAIT_VALUE);
	});

	it('describes a trait by band', () => {
		expect(describeTrait('warmth', 0.9)).toBe('Warm');
		expect(describeTrait('warmth', 0.1)).toBe('Clinical');
		expect(describeTrait('warmth', 0.5)).toBe('Balanced');
		expect(describeTrait('nope', 0.5)).toBe('');
	});
});

describe('compilePersona', () => {
	it('produces a system prompt that starts with "You are"', () => {
		const p = compilePersona({ name: 'Aria', description: 'a research assistant' });
		expect(p.startsWith('You are Aria, a research assistant.')).toBe(true);
		expect(p).toContain('How you communicate:');
	});

	it('is deterministic — same input yields identical output', () => {
		const input = {
			name: 'Aria',
			traits: { warmth: 0.9, humor: 0.8 },
			toneTags: ['warm', 'witty'],
			vocabulary: ['let’s dig in'],
		};
		expect(compilePersona(input)).toBe(compilePersona(input));
	});

	it('changes the prompt when a trait band changes', () => {
		const cold = compilePersona({ name: 'X', traits: { warmth: 0.1 } });
		const warm = compilePersona({ name: 'X', traits: { warmth: 0.95 } });
		expect(cold).not.toBe(warm);
		expect(warm).toContain('genuinely caring');
		expect(cold).toContain('even, professional distance');
	});

	it('weaves a base persona paragraph in verbatim', () => {
		const base = 'You speak like a seasoned trader who has seen three cycles.';
		const p = compilePersona({ name: 'X', base });
		expect(p).toContain(base);
	});

	it('includes tone tags and characteristic phrasing', () => {
		const p = compilePersona({
			name: 'X',
			toneTags: ['punchy', 'candid'],
			vocabulary: ['ship it', 'no fluff'],
		});
		expect(p).toContain('Your tone is punchy, candid.');
		expect(p).toContain('“ship it”');
	});

	it('ties answer-length guidance to verbosity', () => {
		expect(compilePersona({ name: 'X', traits: { verbosity: 0.05 } })).toContain(
			'one to three sentences',
		);
		expect(compilePersona({ name: 'X', traits: { verbosity: 0.95 } })).toContain(
			'genuinely thorough',
		);
	});
});

describe('sanitizers', () => {
	it('dedupes and caps tone tags', () => {
		const tags = sanitizeToneTags(['Warm', 'warm', '  witty ', '', 123, 'a'.repeat(100)]);
		expect(tags).toContain('Warm');
		expect(tags.filter((t) => t.toLowerCase() === 'warm')).toHaveLength(1);
		expect(tags.every((t) => t.length <= 40)).toBe(true);
	});

	it('dedupes and caps vocabulary', () => {
		const v = sanitizeVocabulary(Array.from({ length: 30 }, (_, i) => `phrase ${i % 3}`));
		expect(v.length).toBeLessThanOrEqual(10);
		expect(new Set(v.map((s) => s.toLowerCase())).size).toBe(v.length);
	});
});

describe('registerSummary', () => {
	it('summarises only the non-balanced dimensions', () => {
		expect(registerSummary({ warmth: 0.9, humor: 0.1 })).toBe('Warm · Serious');
	});
	it('reports fully-balanced personas', () => {
		expect(registerSummary(defaultTraitValues())).toBe('Balanced across every dimension');
	});
});

// Oracle narrative classifier — fallback path tests.
//
// The LLM path needs live providers, so here we pin the deterministic heuristic
// (the real fallback) and the parsing/validation guards that keep a malformed
// model response from poisoning the pipeline.

import { describe, it, expect } from 'vitest';
import { heuristicNarrative, CATEGORIES } from '../../api/_lib/oracle/narrative.js';

describe('heuristicNarrative', () => {
	it('always returns a valid category from the taxonomy', () => {
		const out = heuristicNarrative({ name: 'random thing', symbol: 'RND' });
		expect(CATEGORIES).toContain(out.category);
		expect(out.source).toBe('heuristic');
	});

	it('classifies an AI coin', () => {
		const out = heuristicNarrative({ name: 'Autonomous Agent', symbol: 'AGENT', description: 'an agentic AI llm on-chain' });
		expect(out.category).toBe('ai');
		expect(out.tags.length).toBeGreaterThan(0);
	});

	it('classifies an animal meme', () => {
		const out = heuristicNarrative({ name: 'Doge Hat Wif', symbol: 'WIF', description: 'dog wif hat' });
		expect(out.category).toBe('animal');
	});

	it('rewards virality for links + punchy ticker', () => {
		const rich = heuristicNarrative({ name: 'Pepe', symbol: 'PEPE', description: 'the frog returns to glory', twitter: 'x.com/p', telegram: 't.me/p', website: 'p.fun' });
		const bare = heuristicNarrative({ name: 'thing', symbol: 'LONGTICKERNAME' });
		expect(rich.virality).toBeGreaterThan(bare.virality);
		expect(rich.virality).toBeLessThanOrEqual(100);
	});

	it('returns low confidence + unknown on empty signal', () => {
		const out = heuristicNarrative({});
		expect(out.confidence).toBeLessThan(0.3);
		expect(out.category).toBe('unknown');
	});
});

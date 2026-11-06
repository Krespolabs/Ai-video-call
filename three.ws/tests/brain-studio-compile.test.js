// Brain Studio (P1) — graph compiler + normalizer unit tests.
// Pure logic: graph → persona_prompt + provider/memory/skill/market config, and
// the defensive normalizer that protects the editor from malformed stored graphs.

import { describe, it, expect } from 'vitest';
import { compileBrain } from '../src/studio/brain/brain-compile.js';
import { defaultGraph, normalizeGraph, makeNode, edge } from '../src/studio/brain/brain-nodes.js';

describe('compileBrain', () => {
	it('compiles the default graph to a usable persona + provider + memory config', () => {
		const c = compileBrain(defaultGraph(), { agentName: 'Test' });
		expect(c.personaPrompt).toMatch(/^You are /);
		expect(c.provider).toBeTruthy();
		expect(c.maxTokens).toBeGreaterThan(0);
		expect(c.memory).toMatchObject({ topK: expect.any(Number), minScore: expect.any(Number), write: expect.any(Boolean) });
	});

	it('only includes nodes wired (upstream) into the output node', () => {
		const persona = makeNode('persona', 0, 0, { role: 'a wired analyst' });
		const model = makeNode('model', 200, 0, { provider: 'claude-haiku-4-5' });
		const output = makeNode('output', 400, 0);
		// An orphaned skill node NOT connected to the circuit must not leak into tools.
		const orphan = makeNode('skill', 0, 300, { skill: 'ghost-skill' });
		const graph = {
			version: 1,
			nodes: [persona, model, output, orphan],
			edges: [edge(persona, 'identity', model, 'identity'), edge(model, 'reply', output, 'reply')],
		};
		const c = compileBrain(graph);
		expect(c.personaPrompt).toContain('a wired analyst');
		expect(c.provider).toBe('claude-haiku-4-5');
		expect(c.skills).not.toContain('ghost-skill');
	});

	it('renders market reasoning without promoting any coin other than $THREE', () => {
		const persona = makeNode('persona', 0, 0);
		const market = makeNode('market', 0, 200, { trigger: 'breaks-level', level: '0.0042', action: 'propose-action' });
		const model = makeNode('model', 300, 0);
		const output = makeNode('output', 600, 0);
		const graph = {
			version: 1,
			nodes: [persona, market, model, output],
			edges: [edge(persona, 'identity', model, 'identity'), edge(market, 'signal', model, 'context'), edge(model, 'reply', output, 'reply')],
		};
		const c = compileBrain(graph);
		expect(c.marketRules).toHaveLength(1);
		expect(c.personaPrompt).toContain('0.0042');
		expect(c.personaPrompt).toContain('$THREE');
	});
});

describe('normalizeGraph', () => {
	it('falls back to a default graph for garbage input', () => {
		expect(normalizeGraph(null).nodes.length).toBeGreaterThan(0);
		expect(normalizeGraph({ nope: true }).nodes.length).toBeGreaterThan(0);
	});

	it('drops unknown node types and edges referencing missing ports/nodes', () => {
		const persona = makeNode('persona', 0, 0);
		const model = makeNode('model', 200, 0);
		const g = normalizeGraph({
			version: 1,
			nodes: [persona, model, { id: 'x', type: 'bogus', x: 0, y: 0 }],
			edges: [
				edge(persona, 'identity', model, 'identity'), // valid
				{ id: 'bad1', from: persona.id, fromPort: 'identity', to: 'ghost', toPort: 'identity' }, // missing node
				{ id: 'bad2', from: model.id, fromPort: 'nope', to: persona.id, toPort: 'identity' }, // missing port
			],
		});
		expect(g.nodes.find((n) => n.type === 'bogus')).toBeUndefined();
		expect(g.edges).toHaveLength(1);
	});
});

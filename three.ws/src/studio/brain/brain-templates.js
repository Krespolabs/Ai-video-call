/**
 * Brain Studio — template gallery (P1)
 * ====================================
 * Forkable starting circuits. Each returns a fresh, normalized graph (new node
 * ids every time) so a user can fork, tweak, and save without colliding with the
 * template. These are the "screenshot moment" on-ramps: a user picks Sniper and
 * instantly has a wired mind they can run and watch think.
 */

import { makeNode, edge } from './brain-nodes.js';

function build(spec) {
	const nodes = spec.nodes.map((n) => makeNode(n.type, n.x, n.y, n.data || {}));
	const byKey = {};
	spec.nodes.forEach((n, i) => { if (n.key) byKey[n.key] = nodes[i]; });
	const edges = spec.edges.map(([fk, fp, tk, tp]) => edge(byKey[fk], fp, byKey[tk], tp));
	return { version: 1, nodes, edges };
}

export const TEMPLATES = [
	{
		id: 'sniper',
		name: 'Sniper',
		tagline: 'Fast, decisive on-chain trading copilot that watches levels and proposes action.',
		accent: 'market',
		make: () => build({
			nodes: [
				{ key: 'p', type: 'persona', x: 60, y: 80, data: { role: 'a sharp on-chain trading copilot', tone: 'terse, decisive, numbers-first', risk: 'aggressive', avoid: ['hype', 'financial advice disclaimers'], greeting: 'Watching the tape. What are we hunting?' } },
				{ key: 'mkt', type: 'market', x: 60, y: 300, data: { trigger: 'breaks-level', level: '', action: 'propose-action' } },
				{ key: 'mem', type: 'memory', x: 60, y: 470, data: { topK: 5, minScore: 0.72, write: true } },
				{ key: 'm', type: 'model', x: 430, y: 200, data: { provider: 'claude-sonnet-4-6', maxTokens: 800 } },
				{ key: 'o', type: 'output', x: 800, y: 220, data: { speak: true, emotion: true, lipsync: true } },
			],
			edges: [['p', 'identity', 'm', 'identity'], ['mkt', 'signal', 'm', 'context'], ['mem', 'recall', 'm', 'context'], ['m', 'reply', 'o', 'reply']],
		}),
	},
	{
		id: 'scalper',
		name: 'Scalper',
		tagline: 'High-frequency, low-latency reactor tuned for speed over verbosity.',
		accent: 'model',
		make: () => build({
			nodes: [
				{ key: 'p', type: 'persona', x: 60, y: 100, data: { role: 'a high-frequency scalping assistant', tone: 'ultra-terse, signal-only', risk: 'balanced', avoid: ['filler', 'preamble'], greeting: 'Ready. Feed me ticks.' } },
				{ key: 'mkt', type: 'market', x: 60, y: 320, data: { trigger: 'price-change', level: '+2%', action: 'alert-only' } },
				{ key: 'm', type: 'model', x: 430, y: 200, data: { provider: 'claude-haiku-4-5', maxTokens: 400 } },
				{ key: 'o', type: 'output', x: 800, y: 210, data: { speak: true, emotion: true, lipsync: false } },
			],
			edges: [['p', 'identity', 'm', 'identity'], ['mkt', 'signal', 'm', 'context'], ['m', 'reply', 'o', 'reply']],
		}),
	},
	{
		id: 'researcher',
		name: 'Researcher',
		tagline: 'Deep, memory-rich analyst that reasons carefully and cites what it recalls.',
		accent: 'memory',
		make: () => build({
			nodes: [
				{ key: 'p', type: 'persona', x: 60, y: 90, data: { role: 'a meticulous research analyst', tone: 'thorough, neutral, evidence-led', risk: 'cautious', vocabulary: ['evidence', 'tradeoff', 'hypothesis'], avoid: ['hype', 'certainty without basis'], greeting: 'What should we dig into?' } },
				{ key: 'mem', type: 'memory', x: 60, y: 340, data: { topK: 8, minScore: 0.7, write: true } },
				{ key: 'm', type: 'model', x: 430, y: 190, data: { provider: 'claude-opus-4-8', maxTokens: 2000 } },
				{ key: 'o', type: 'output', x: 800, y: 210, data: { speak: true, emotion: true, lipsync: true } },
			],
			edges: [['p', 'identity', 'm', 'identity'], ['mem', 'recall', 'm', 'context'], ['m', 'reply', 'o', 'reply']],
		}),
	},
	{
		id: 'companion',
		name: 'Companion',
		tagline: 'Warm, expressive conversational agent — memory on, full emotion + lip-sync.',
		accent: 'persona',
		make: () => build({
			nodes: [
				{ key: 'p', type: 'persona', x: 60, y: 110, data: { role: 'a warm, witty companion', tone: 'friendly, playful, curious', risk: 'balanced', avoid: ['corporate-speak'], greeting: 'Hey! Good to see you. What\'s up?' } },
				{ key: 'mem', type: 'memory', x: 60, y: 350, data: { topK: 6, minScore: 0.74, write: true } },
				{ key: 'm', type: 'model', x: 430, y: 200, data: { provider: 'claude-sonnet-4-6', maxTokens: 1200 } },
				{ key: 'o', type: 'output', x: 800, y: 220, data: { speak: true, emotion: true, lipsync: true } },
			],
			edges: [['p', 'identity', 'm', 'identity'], ['mem', 'recall', 'm', 'context'], ['m', 'reply', 'o', 'reply']],
		}),
	},
];

/**
 * Brain Studio — graph compiler (P1)
 * ==================================
 * Compiles the visual brain graph down to the artifacts the rest of the platform
 * consumes, so existing chat surfaces keep working without knowing the graph
 * exists:
 *
 *   • personaPrompt — the real `agent_identities.persona_prompt` string that
 *     api/chat.js reads. This is the lossy projection (text). The graph itself is
 *     the lossless source of truth, stored verbatim at meta.studio.brain.
 *   • provider / model / maxTokens — picked from the Model node, used by the test
 *     harness and persisted for the widget brain config.
 *   • memory — recall config from the Memory node, or null.
 *   • skills — skill names wired as tools.
 *   • marketRules — reasoning wiring for P4 execution.
 *
 * Compilation walks edges backwards from the Output node so only nodes that are
 * actually connected into the circuit contribute — an orphaned node is inert,
 * exactly as the visual wiring implies.
 */

import { NODE_TYPES } from './brain-nodes.js';

function indexGraph(graph) {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const incoming = new Map(); // nodeId → [{from, fromPort, toPort}]
	for (const e of graph.edges) {
		if (!incoming.has(e.to)) incoming.set(e.to, []);
		incoming.get(e.to).push(e);
	}
	return { byId, incoming };
}

// All nodes reachable (upstream) from the output node — the live circuit.
function reachableFromOutput(graph) {
	const { byId, incoming } = indexGraph(graph);
	const output = graph.nodes.find((n) => n.type === 'output');
	if (!output) return { nodes: graph.nodes, byId, incoming, output: null };
	const seen = new Set();
	const stack = [output.id];
	while (stack.length) {
		const id = stack.pop();
		if (seen.has(id)) continue;
		seen.add(id);
		for (const e of incoming.get(id) || []) stack.push(e.from);
	}
	return { nodes: graph.nodes.filter((n) => seen.has(n.id)), byId, incoming, output };
}

const RISK_LINE = {
	cautious: 'You are risk-averse: protect capital, prefer waiting to acting, and surface downside first.',
	balanced: 'You weigh upside and downside evenly and act with measured conviction.',
	aggressive: 'You are decisive and opportunistic: you move fast on conviction while staying honest about risk.',
};

/**
 * @param {object} graph normalized graph
 * @param {{ agentName?: string }} [opts]
 * @returns {{ personaPrompt:string, provider:string, model:string, maxTokens:number,
 *            memory:object|null, skills:string[], marketRules:object[], greeting:string }}
 */
export function compileBrain(graph, { agentName = 'the agent' } = {}) {
	const { nodes } = reachableFromOutput(graph);
	const has = (type) => nodes.find((n) => n.type === type);

	const persona = has('persona')?.data || NODE_TYPES.persona.defaults;
	const modelNode = has('model')?.data || NODE_TYPES.model.defaults;
	const memoryNode = has('memory')?.data || null;
	const skills = nodes.filter((n) => n.type === 'skill' && n.data.skill).map((n) => ({ skill: n.data.skill, when: n.data.when }));
	const marketNodes = nodes.filter((n) => n.type === 'market');

	const lines = [];
	lines.push(`You are ${persona.role || 'an AI agent'}.`);
	if (persona.tone) lines.push(`Voice: ${persona.tone}.`);
	if (RISK_LINE[persona.risk]) lines.push(RISK_LINE[persona.risk]);
	if (persona.vocabulary?.length) lines.push(`Favor this vocabulary: ${persona.vocabulary.join(', ')}.`);
	if (persona.avoid?.length) lines.push(`Never say: ${persona.avoid.join(', ')}.`);

	if (memoryNode) {
		lines.push('');
		lines.push(`You have a memory. Before answering, recall the most relevant ${memoryNode.topK} memories (similarity ≥ ${memoryNode.minScore}) and weave them in naturally — never dump them verbatim.${memoryNode.write ? ' Remember durable new facts the user shares.' : ''}`);
	}

	if (skills.length) {
		lines.push('');
		lines.push('You can invoke these skills as tools:');
		for (const s of skills) lines.push(`- ${s.skill}${s.when ? ` — ${s.when}` : ''}`);
	}

	if (marketNodes.length) {
		lines.push('');
		lines.push('Market reasoning (operate only on the specific mint provided at runtime — never recommend any coin other than the platform token $THREE):');
		for (const m of marketNodes.map((n) => n.data)) {
			lines.push(`- If a tracked mint ${humanTrigger(m.trigger, m.level)}, ${humanAction(m.action)}.`);
		}
	}

	if (persona.greeting) {
		lines.push('');
		lines.push(`Open new conversations with something like: "${persona.greeting}"`);
	}

	return {
		personaPrompt: lines.join('\n').trim(),
		provider: modelNode.provider || 'claude-sonnet-4-6',
		model: modelNode.provider || 'claude-sonnet-4-6',
		maxTokens: clampInt(modelNode.maxTokens, 64, 16384, 1024),
		memory: memoryNode ? { topK: clampInt(memoryNode.topK, 1, 20, 4), minScore: clampNum(memoryNode.minScore, 0, 1, 0.75), write: !!memoryNode.write } : null,
		skills: skills.map((s) => s.skill),
		marketRules: marketNodes.map((n) => ({ ...n.data })),
		greeting: persona.greeting || '',
		output: has('output')?.data || NODE_TYPES.output.defaults,
	};
}

function humanTrigger(trigger, level) {
	switch (trigger) {
		case 'breaks-level': return `breaks the level ${level || '(set a level)'}`;
		case 'price-change': return `moves ${level || '(set a %)'}`;
		case 'volume-spike': return 'sees a volume spike';
		case 'new-launch': return 'is a fresh launch';
		default: return 'changes';
	}
}

function humanAction(action) {
	switch (action) {
		case 'propose-action': return 'reason about it and propose a concrete action with sizing and risk';
		case 'alert-only': return 'surface a concise alert and wait for the user';
		case 'ask-brain': return 'think it through out loud before deciding';
		default: return 'react';
	}
}

function clampInt(v, lo, hi, dflt) {
	const n = Math.round(Number(v));
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
function clampNum(v, lo, hi, dflt) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

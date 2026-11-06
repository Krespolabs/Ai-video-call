/**
 * Brain Studio — node type registry + execution interface (P1)
 * ============================================================
 * The Brain graph is a small set of typed nodes wired into a circuit that IS the
 * agent's persona. This module defines every node type, its ports, its editable
 * fields, and the extension seam P4 (trading execution) binds to.
 *
 * Saved graph format (lives at meta.studio.brain — OUR schema, not a library's):
 *
 *   {
 *     version: 1,
 *     nodes: [{ id, type, x, y, data: {…type-specific} }],
 *     edges: [{ id, from, fromPort, to, toPort }],
 *     compiled?: { personaPrompt, provider, model, ... }   // last compile snapshot
 *   }
 *
 * Ports carry a `kind` so the editor only allows sane connections:
 *   'signal'  — control/flow (persona → model → output)
 *   'context' — text injected into the model's system prompt (memory, skills, market)
 *   'tool'    — an invokable capability (skill, market reasoning) the brain may call
 *
 * ── Node execution interface (the contract P4 should target) ──────────────────
 * The Brain Studio's test harness (brain-runtime.js) executes the graph. Persona,
 * Model, Memory and Output have built-in runners here. Skill and Market/Reasoning
 * nodes define their INTERFACE here but defer EXECUTION to P4 via:
 *
 *   import { registerNodeRunner } from './brain-nodes.js';
 *   registerNodeRunner('market', async (node, ctx) => {
 *     // ctx = { mint, brain, recall(query), emit(protocolAction), signal (AbortSignal),
 *     //         say(text), now }
 *     // return { context?: string, tool?: {...}, fired?: boolean }
 *   });
 *
 * Until P4 registers a runner, these nodes contribute their reasoning INSTRUCTIONS
 * to the system prompt (so the brain reasons about them in language) but perform no
 * side effects — never a mock, just language-level wiring awaiting execution.
 */

// Emotion vocabulary the Output node can drive (matches agent-avatar.js).
export const EMOTIONS = ['neutral', 'celebration', 'concern', 'curiosity', 'empathy', 'patience', 'uncertain'];

export const PORT_KINDS = { SIGNAL: 'signal', CONTEXT: 'context', TOOL: 'tool' };

// Each node type: ports, defaults, editor field schema, and an optional built-in
// runner. `accent` is a CSS token class suffix for the node header.
export const NODE_TYPES = {
	persona: {
		title: 'Persona',
		accent: 'persona',
		single: true, // only one allowed in a graph
		inputs: [],
		outputs: [{ id: 'identity', label: 'identity', kind: PORT_KINDS.SIGNAL }],
		defaults: {
			role: 'a sharp, helpful AI agent',
			tone: 'direct, warm, plain-spoken',
			risk: 'balanced',
			vocabulary: [],
			avoid: ['hype', 'buzzwords'],
			greeting: 'Hey — what are we working on?',
		},
		fields: [
			{ key: 'role', label: 'Role', type: 'text', placeholder: 'a sharp crypto trading copilot' },
			{ key: 'tone', label: 'Tone', type: 'text', placeholder: 'direct, a little sardonic' },
			{ key: 'risk', label: 'Risk appetite', type: 'select', options: ['cautious', 'balanced', 'aggressive'] },
			{ key: 'vocabulary', label: 'Vocabulary (favor)', type: 'tags' },
			{ key: 'avoid', label: 'Avoid', type: 'tags' },
			{ key: 'greeting', label: 'Greeting', type: 'textarea' },
		],
	},

	model: {
		title: 'Model',
		accent: 'model',
		inputs: [
			{ id: 'identity', label: 'identity', kind: PORT_KINDS.SIGNAL },
			{ id: 'context', label: 'context', kind: PORT_KINDS.CONTEXT },
			{ id: 'tools', label: 'tools', kind: PORT_KINDS.TOOL },
		],
		outputs: [{ id: 'reply', label: 'reply', kind: PORT_KINDS.SIGNAL }],
		defaults: { provider: 'claude-sonnet-4-6', maxTokens: 1024 },
		fields: [
			{ key: 'provider', label: 'Model', type: 'provider' }, // populated from /api/brain/chat (GET)
			{ key: 'maxTokens', label: 'Max tokens', type: 'number', min: 64, max: 16384, step: 64 },
		],
	},

	memory: {
		title: 'Memory',
		accent: 'memory',
		inputs: [{ id: 'query', label: 'query', kind: PORT_KINDS.SIGNAL }],
		outputs: [{ id: 'recall', label: 'recall', kind: PORT_KINDS.CONTEXT }],
		// Mirrors mem0 search() ergonomics + Letta tiered recall (topK / minScore).
		defaults: { topK: 4, minScore: 0.75, write: true },
		fields: [
			{ key: 'topK', label: 'Recall top-K', type: 'number', min: 1, max: 20, step: 1 },
			{ key: 'minScore', label: 'Min similarity', type: 'number', min: 0, max: 1, step: 0.05 },
			{ key: 'write', label: 'Write new memories', type: 'toggle' },
		],
	},

	skill: {
		title: 'Skill',
		accent: 'skill',
		inputs: [],
		outputs: [{ id: 'tool', label: 'tool', kind: PORT_KINDS.TOOL }],
		defaults: { skill: '', when: 'when the user asks for it' },
		fields: [
			{ key: 'skill', label: 'Skill', type: 'skill' }, // populated from agent.skills[]
			{ key: 'when', label: 'Invoke when', type: 'text' },
		],
	},

	market: {
		title: 'Market signal',
		accent: 'market',
		inputs: [],
		outputs: [{ id: 'signal', label: 'signal', kind: PORT_KINDS.CONTEXT }],
		// Reasoning wiring only — execution is P4's. Operates on a runtime-supplied
		// mint (never a hardcoded coin; $THREE is the only coin the platform promotes).
		defaults: { trigger: 'breaks-level', level: '', action: 'propose-action' },
		fields: [
			{ key: 'trigger', label: 'Trigger', type: 'select', options: ['breaks-level', 'price-change', 'volume-spike', 'new-launch'] },
			{ key: 'level', label: 'Level / threshold', type: 'text', placeholder: 'e.g. 0.0042 or +15%' },
			{ key: 'action', label: 'Then', type: 'select', options: ['propose-action', 'alert-only', 'ask-brain'] },
		],
	},

	output: {
		title: 'Avatar output',
		accent: 'output',
		single: true,
		inputs: [{ id: 'reply', label: 'reply', kind: PORT_KINDS.SIGNAL }],
		outputs: [],
		defaults: { speak: true, emotion: true, lipsync: true },
		fields: [
			{ key: 'speak', label: 'Speak reply', type: 'toggle' },
			{ key: 'emotion', label: 'Emotional reactions', type: 'toggle' },
			{ key: 'lipsync', label: 'Lip-sync', type: 'toggle' },
		],
	},
};

// Connection rule: an output port may connect to an input port of the same kind.
export function canConnect(fromKind, toKind) {
	return fromKind === toKind;
}

// ── Execution runner registry (P4 extension point) ──────────────────────────
const RUNNERS = new Map();

/**
 * Register an execution runner for a node type (P4: 'market', and richer 'skill').
 * @param {string} type
 * @param {(node:object, ctx:object)=>Promise<{context?:string,tool?:object,fired?:boolean}>} fn
 */
export function registerNodeRunner(type, fn) {
	if (!NODE_TYPES[type]) throw new Error(`registerNodeRunner: unknown node type "${type}"`);
	RUNNERS.set(type, fn);
}

export function getNodeRunner(type) {
	return RUNNERS.get(type) || null;
}

// ── Graph construction helpers ──────────────────────────────────────────────

let _seq = 0;
export function nodeId(type) {
	_seq += 1;
	return `${type}_${Date.now().toString(36)}_${_seq}`;
}

export function makeNode(type, x, y, data = {}) {
	const spec = NODE_TYPES[type];
	if (!spec) throw new Error(`makeNode: unknown type ${type}`);
	return { id: nodeId(type), type, x, y, data: { ...structuredClone(spec.defaults), ...data } };
}

// A sensible starter circuit: Persona → Model → Avatar output, with Memory wired
// into the model's context. The user fleshes it out from here.
export function defaultGraph() {
	const persona = makeNode('persona', 80, 120);
	const memory = makeNode('memory', 80, 360);
	const model = makeNode('model', 440, 200);
	const output = makeNode('output', 800, 220);
	return {
		version: 1,
		nodes: [persona, memory, model, output],
		edges: [
			edge(persona, 'identity', model, 'identity'),
			edge(memory, 'recall', model, 'context'),
			edge(model, 'reply', output, 'reply'),
		],
	};
}

export function edge(fromNode, fromPort, toNode, toPort) {
	return {
		id: `e_${fromNode.id}.${fromPort}-${toNode.id}.${toPort}`,
		from: fromNode.id,
		fromPort,
		to: toNode.id,
		toPort,
	};
}

// Validate + normalize a graph loaded from storage so a hand-edited or legacy bag
// can't crash the editor. Drops nodes of unknown type and edges to missing ports.
export function normalizeGraph(g) {
	if (!g || typeof g !== 'object' || !Array.isArray(g.nodes)) return defaultGraph();
	const nodes = g.nodes.filter((n) => n && NODE_TYPES[n.type]).map((n) => ({
		id: String(n.id),
		type: n.type,
		x: Number.isFinite(n.x) ? n.x : 100,
		y: Number.isFinite(n.y) ? n.y : 100,
		data: { ...structuredClone(NODE_TYPES[n.type].defaults), ...(n.data || {}) },
	}));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const portExists = (node, portId, dir) =>
		node && NODE_TYPES[node.type][dir].some((p) => p.id === portId);
	const edges = (Array.isArray(g.edges) ? g.edges : []).filter((e) =>
		e && byId.has(e.from) && byId.has(e.to) &&
		portExists(byId.get(e.from), e.fromPort, 'outputs') &&
		portExists(byId.get(e.to), e.toPort, 'inputs'),
	).map((e) => ({ id: e.id || `e_${e.from}.${e.fromPort}-${e.to}.${e.toPort}`, from: e.from, fromPort: e.fromPort, to: e.to, toPort: e.toPort }));
	return { version: 1, nodes, edges, compiled: g.compiled || null };
}

import { describe, it, expect, vi } from 'vitest';
import {
	extractPlanJson,
	normalizePlan,
	splitBudget,
	clampBudget,
	buildTaskTree,
	applyTransition,
	narrateNode,
	orchestrateGoal,
	MAX_SUBTASKS,
	HARD_MAX_USD,
	DEFAULT_MAX_USD,
} from '../api/_lib/agent-orchestrate.js';

describe('extractPlanJson', () => {
	it('parses a raw JSON object', () => {
		const out = extractPlanJson('{"subtasks":[{"title":"a","kind":"delegate"}]}');
		expect(out.subtasks).toHaveLength(1);
	});

	it('parses JSON wrapped in prose and code fences', () => {
		const text = 'Sure! Here is the plan:\n```json\n{"subtasks":[{"title":"x","kind":"hire","serviceSlug":"s"}]}\n```\nDone.';
		const out = extractPlanJson(text);
		expect(out.subtasks[0].serviceSlug).toBe('s');
	});

	it('is string-aware so a brace inside a value does not close early', () => {
		const out = extractPlanJson('{"subtasks":[{"title":"use } char","kind":"delegate"}]}');
		expect(out.subtasks[0].title).toBe('use } char');
	});

	it('returns null on no JSON or malformed JSON', () => {
		expect(extractPlanJson('no json here')).toBeNull();
		expect(extractPlanJson('{not valid')).toBeNull();
		expect(extractPlanJson(null)).toBeNull();
	});
});

describe('normalizePlan — plan → tree shaping', () => {
	const leadAgentId = 'lead-1';

	it('keeps valid delegate + hire sub-tasks and defaults delegate target to the lead', () => {
		const raw = {
			subtasks: [
				{ title: 'research', kind: 'delegate', instruction: 'do research' },
				{ title: 'scan', kind: 'hire', serviceSlug: 'sentiment-scan', input: { mint: 'x' } },
			],
		};
		const out = normalizePlan(raw, { leadAgentId, allowedSlugs: ['sentiment-scan'] });
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ kind: 'delegate', agentId: leadAgentId });
		expect(out[1]).toMatchObject({ kind: 'hire', serviceSlug: 'sentiment-scan' });
		expect(out[1].input).toEqual({ mint: 'x' });
	});

	it('downgrades a hire with an unknown/disallowed slug to a free delegate', () => {
		const raw = { subtasks: [{ title: 'pump', kind: 'hire', serviceSlug: 'not-real' }] };
		const out = normalizePlan(raw, { leadAgentId, allowedSlugs: ['sentiment-scan'] });
		expect(out[0].kind).toBe('delegate');
		expect(out[0].agentId).toBe(leadAgentId);
		expect(out[0].serviceSlug).toBeUndefined();
	});

	it('drops entries without a title and caps the count at maxSubtasks', () => {
		const raw = { subtasks: [{ kind: 'delegate' }, ...Array.from({ length: 20 }, (_, i) => ({ title: `t${i}` }))] };
		const out = normalizePlan(raw, { leadAgentId });
		expect(out.length).toBe(MAX_SUBTASKS);
		expect(out.every((s) => s.title)).toBe(true);
	});

	it('returns an empty list for a missing/garbage plan', () => {
		expect(normalizePlan(null, { leadAgentId })).toEqual([]);
		expect(normalizePlan({ subtasks: 'nope' }, { leadAgentId })).toEqual([]);
	});
});

describe('splitBudget / clampBudget — budget never exceeds total', () => {
	it('splits evenly across hire nodes, floored to cents, sum <= total', () => {
		const subtasks = [
			{ kind: 'hire' }, { kind: 'delegate' }, { kind: 'hire' }, { kind: 'hire' },
		];
		const slices = splitBudget(subtasks, 1.0);
		expect(slices[1]).toBeNull(); // delegate costs nothing
		const hireSlices = slices.filter((s) => s != null);
		expect(hireSlices).toHaveLength(3);
		// 1.00 / 3 = 0.33 floored, sum 0.99 <= 1.00
		hireSlices.forEach((s) => expect(s).toBe(0.33));
		expect(hireSlices.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1.0 + 1e-9);
	});

	it('returns all-null when there are no hire nodes', () => {
		expect(splitBudget([{ kind: 'delegate' }, { kind: 'delegate' }], 2)).toEqual([null, null]);
	});

	it('never lets the summed slices exceed the total for any cap/count', () => {
		for (const cap of [0.01, 0.1, 1, 2.5, HARD_MAX_USD]) {
			for (const count of [1, 2, 3, 5, 7]) {
				const subtasks = Array.from({ length: count }, () => ({ kind: 'hire' }));
				const sum = splitBudget(subtasks, cap).reduce((a, b) => a + (b || 0), 0);
				expect(sum).toBeLessThanOrEqual(cap + 1e-9);
			}
		}
	});

	it('clamps budget into (0, HARD_MAX_USD] with a sane default', () => {
		expect(clampBudget(-5)).toBe(DEFAULT_MAX_USD);
		expect(clampBudget(0)).toBe(DEFAULT_MAX_USD);
		expect(clampBudget('nan')).toBe(DEFAULT_MAX_USD);
		expect(clampBudget(999)).toBe(HARD_MAX_USD);
		expect(clampBudget(2)).toBe(2);
	});
});

describe('buildTaskTree + applyTransition', () => {
	const leadAgentId = 'lead-1';
	const subtasks = [
		{ title: 'research', kind: 'delegate', agentId: leadAgentId },
		{ title: 'scan', kind: 'hire', serviceSlug: 'sentiment-scan' },
	];

	it('builds a two-level tree: lead + one child per sub-task, edges fan out', () => {
		const tree = buildTaskTree({ taskId: 't1', leadAgentId, goal: 'do it', maxUsd: 1, subtasks });
		expect(tree.nodes[0].id).toBe('lead');
		expect(tree.nodes).toHaveLength(3);
		expect(tree.edges).toEqual([{ from: 'lead', to: 'n0' }, { from: 'lead', to: 'n1' }]);
		expect(tree.nodes[1].status).toBe('queued');
		expect(tree.nodes[2].serviceSlug).toBe('sentiment-scan');
		expect(tree.nodes[2].maxUsd).toBe(1); // single hire gets full cap
	});

	it('applyTransition returns a fresh tree and recomputes spend + status', () => {
		const tree = buildTaskTree({ taskId: 't1', leadAgentId, goal: 'do it', maxUsd: 1, subtasks });
		const t2 = applyTransition(tree, 'n1', { status: 'done', costUsd: 0.5 });
		expect(t2).not.toBe(tree);
		expect(tree.nodes[2].status).toBe('queued'); // original untouched
		expect(t2.budgetSpentUsd).toBe(0.5);

		const t3 = applyTransition(t2, 'n0', { status: 'done' });
		const t4 = applyTransition(t3, 'lead', { status: 'done' });
		expect(t4.status).toBe('done'); // all children + lead done
	});

	it('marks the task completed_with_errors when any node failed', () => {
		let tree = buildTaskTree({ taskId: 't1', leadAgentId, goal: 'g', maxUsd: 1, subtasks });
		tree = applyTransition(tree, 'n0', { status: 'done' });
		tree = applyTransition(tree, 'n1', { status: 'failed', error: 'budget exceeded' });
		tree = applyTransition(tree, 'lead', { status: 'done' });
		expect(tree.status).toBe('completed_with_errors');
	});
});

describe('narrateNode', () => {
	it('narrates a paid hire with cost and receipt', () => {
		const line = narrateNode({ kind: 'hire', title: 'sentiment scan', status: 'done', costUsd: 0.02, signature: '5xRabcdefghijk' });
		expect(line).toMatch(/Hired/);
		expect(line).toMatch(/\$0\.02/);
		expect(line).toMatch(/5xRabcd/);
	});

	it('narrates a failed hire with the reason', () => {
		const line = narrateNode({ kind: 'hire', title: 'scan', status: 'failed', error: 'budget exceeded' });
		expect(line).toMatch(/budget exceeded/);
	});
});

describe('orchestrateGoal — graph-delta sequencing', () => {
	const base = { userId: 'u1', leadAgentId: 'lead-1', leadName: 'Lead', goal: 'research a coin' };

	function fakeDelegate(plan) {
		// First call (planning) returns the plan JSON; later calls echo the message.
		let first = true;
		return vi.fn(async ({ message }) => {
			if (first) { first = false; return { response: JSON.stringify(plan) }; }
			return { response: `did: ${message.slice(0, 20)}` };
		});
	}

	it('emits monotonic queued → running → done transitions and a final tree', async () => {
		const plan = { subtasks: [
			{ title: 'research', kind: 'delegate', instruction: 'research the coin' },
			{ title: 'sentiment', kind: 'hire', serviceSlug: 'sentiment-scan' },
		] };
		const runDelegate = fakeDelegate(plan);
		const runHire = vi.fn(async ({ maxUsd }) => ({
			hire: { usd: maxUsd, provider_agent_id: 'prov-1', provider: { name: 'Kestrel' }, invocation_signature: 'sig123', invocation_explorer: 'https://solscan.io/tx/sig123' },
			result: 'sentiment: bullish',
		}));

		const snapshots = [];
		const tree = await orchestrateGoal(
			{ ...base, maxUsd: 1, catalog: [{ slug: 'sentiment-scan', name: 'Sentiment', price_usdc: 0.02 }], emit: (t) => snapshots.push(structuredClone(t)) },
			{ runDelegate, runHire, makeTaskId: () => 'task-1' },
		);

		// First snapshot is the planning phase; last is the finished tree.
		expect(snapshots[0].status).toBe('planning');
		expect(tree.taskId).toBe('task-1');
		expect(tree.status).toBe('done');

		// The hire node ran through queued → running → done across snapshots.
		const hireStatuses = snapshots.map((s) => s.nodes.find((n) => n.id === 'n1')?.status).filter(Boolean);
		expect(hireStatuses).toContain('queued');
		expect(hireStatuses.indexOf('running')).toBeLessThan(hireStatuses.lastIndexOf('done'));

		// Real signature + cost landed on the hire node; budget respected.
		const hireNode = tree.nodes.find((n) => n.id === 'n1');
		expect(hireNode.status).toBe('done');
		expect(hireNode.signature).toBe('sig123');
		expect(hireNode.costUsd).toBe(1); // single hire → full cap slice
		expect(tree.budgetSpentUsd).toBeLessThanOrEqual(tree.maxUsd + 1e-9);

		// The lead synthesized at the end.
		expect(tree.nodes[0].status).toBe('done');
		expect(runHire).toHaveBeenCalledOnce();
	});

	it('a failed hire turns one node red but the rest of the team continues', async () => {
		const plan = { subtasks: [
			{ title: 'scan', kind: 'hire', serviceSlug: 'sentiment-scan' },
			{ title: 'summary', kind: 'delegate', instruction: 'summarize' },
		] };
		const runDelegate = fakeDelegate(plan);
		const runHire = vi.fn(async () => { throw Object.assign(new Error('over budget'), { code: 'over_cap' }); });

		const tree = await orchestrateGoal(
			{ ...base, maxUsd: 0.5, catalog: [{ slug: 'sentiment-scan', name: 'S', price_usdc: 1 }] },
			{ runDelegate, runHire, makeTaskId: () => 't' },
		);

		const hireNode = tree.nodes.find((n) => n.id === 'n0');
		expect(hireNode.status).toBe('failed');
		expect(hireNode.error).toBe('budget exceeded');
		// The delegate sub-task still completed, and so did the lead.
		expect(tree.nodes.find((n) => n.id === 'n1').status).toBe('done');
		expect(tree.nodes[0].status).toBe('done');
		expect(tree.status).toBe('completed_with_errors');
	});

	it('handles a solo goal (empty plan) as a single lead node', async () => {
		const runDelegate = fakeDelegate({ subtasks: [] });
		const runHire = vi.fn();
		const tree = await orchestrateGoal(
			{ ...base, maxUsd: 1, emit: () => {} },
			{ runDelegate, runHire, makeTaskId: () => 't' },
		);
		expect(tree.nodes).toHaveLength(1);
		expect(tree.nodes[0].status).toBe('done');
		expect(runHire).not.toHaveBeenCalled();
	});

	it('never exceeds the total budget across multiple hires', async () => {
		const plan = { subtasks: [
			{ title: 'a', kind: 'hire', serviceSlug: 's' },
			{ title: 'b', kind: 'hire', serviceSlug: 's' },
			{ title: 'c', kind: 'hire', serviceSlug: 's' },
		] };
		const runDelegate = fakeDelegate(plan);
		// Each provider charges exactly its allotted slice.
		const runHire = vi.fn(async ({ maxUsd }) => ({ hire: { usd: maxUsd, invocation_signature: 's' }, result: 'ok' }));
		const tree = await orchestrateGoal(
			{ ...base, maxUsd: 1, catalog: [{ slug: 's', name: 'S', price_usdc: 0.3 }] },
			{ runDelegate, runHire, makeTaskId: () => 't' },
		);
		expect(tree.budgetSpentUsd).toBeLessThanOrEqual(1 + 1e-9);
		expect(runHire).toHaveBeenCalledTimes(3);
	});

	it('falls back to a solo failed-plan node when planning throws', async () => {
		const runDelegate = vi.fn(async () => { throw Object.assign(new Error('no llm'), { code: 'llm_unavailable' }); });
		const tree = await orchestrateGoal(
			{ ...base, maxUsd: 1 },
			{ runDelegate, runHire: vi.fn(), makeTaskId: () => 't' },
		);
		expect(tree.nodes).toHaveLength(1);
		expect(tree.nodes[0].status).toBe('failed');
		expect(tree.nodes[0].error).toMatch(/unavailable/);
	});

	it('returns a partial tree (not a hang) when the time budget runs out mid-run', async () => {
		const plan = { subtasks: [
			{ title: 'first', kind: 'delegate', instruction: 'do first' },
			{ title: 'second', kind: 'delegate', instruction: 'do second' },
			{ title: 'third', kind: 'delegate', instruction: 'do third' },
		] };
		const runDelegate = fakeDelegate(plan);
		// A deadline already in the past forces the loop to skip every child and the
		// final synthesis turn — the run must still resolve with a truthful tree.
		const tree = await orchestrateGoal(
			{ ...base, maxUsd: 1, deadlineMs: Date.now() - 1 },
			{ runDelegate, runHire: vi.fn(), makeTaskId: () => 't' },
		);
		const children = tree.nodes.filter((n) => n.id !== 'lead');
		expect(children).toHaveLength(3);
		// No child ran (planning is the only delegate call), and each is marked
		// skipped rather than left dangling in 'queued'.
		expect(children.every((n) => n.status === 'failed')).toBe(true);
		expect(children.every((n) => /ran out of time/.test(n.error))).toBe(true);
		expect(runDelegate).toHaveBeenCalledOnce(); // planning only — no node/synthesis turns
		// The lead resolves done-with-a-partial-note, so the handler returns 200.
		expect(tree.nodes[0].status).toBe('done');
		expect(tree.nodes[0].error).toMatch(/partial/);
		expect(tree.status).toBe('completed_with_errors');
	});

	it('finishes normally when the deadline is never reached (default = no limit)', async () => {
		const plan = { subtasks: [{ title: 'only', kind: 'delegate', instruction: 'do it' }] };
		const runDelegate = fakeDelegate(plan);
		const tree = await orchestrateGoal(
			{ ...base, maxUsd: 1 },
			{ runDelegate, runHire: vi.fn(), makeTaskId: () => 't' },
		);
		expect(tree.nodes.find((n) => n.id === 'n0').status).toBe('done');
		expect(tree.nodes[0].status).toBe('done');
		expect(tree.status).toBe('done');
	});
});

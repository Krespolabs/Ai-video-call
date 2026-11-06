/**
 * Task-step sequencer + narration ordering for the on-demand caster pool.
 *
 * The "watch an agent do real web work" moment depends on one invariant: for
 * every step the agent narrates what it's ABOUT to do a beat BEFORE it does it,
 * then lands a screenshot AFTER. This test pins that ordering by driving the pure
 * sequencer (workers/agent-screen-pool/task-runner.js) with a recording executor
 * — no Chromium, no network — so the lead-then-act-then-shot contract can't
 * silently regress, and verifies abort/failure handling and the $THREE
 * single-coin rule over the task library.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runTaskSteps, parseNarrationJson } from '../workers/agent-screen-pool/task-runner.js';
import { TASKS, pickTask, getTask } from '../workers/agent-screen-pool/tasks/index.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// A recording executor: every method appends a tagged event so the test can
// assert exact call order across all steps.
function recordingExecutor(events, opts = {}) {
	return {
		async narrate(line, step) { events.push({ op: 'narrate', id: step.id, line }); },
		async perform(step) {
			events.push({ op: 'perform', id: step.id });
			if (opts.failOn === step.id) throw new Error('boom');
			return step.kind === 'read' ? 'EXTRACTED TEXT' : null;
		},
		async shot(step, result) { events.push({ op: 'shot', id: step.id, result }); },
		async fail(step, err) { events.push({ op: 'fail', id: step.id, err: err.message }); },
		async done(task) { events.push({ op: 'done', id: task.id }); },
	};
}

const sampleTask = {
	id: 'sample',
	title: 'Sample',
	topic: 'testing',
	steps: [
		{ id: 'open', kind: 'goto', url: 'https://example.com', narration: 'Opening the page' },
		{ id: 'type', kind: 'type', selector: '#q', value: 'hi', narration: 'Typing the query' },
		{ id: 'read', kind: 'read', selector: '#out', narration: 'Reading the result' },
	],
};

describe('agent-screen pool — task sequencer', () => {
	it('narrates a step before performing it, and shoots after — for every step, in order', async () => {
		const events = [];
		const narration = { open: 'lead-open', type: 'lead-type', read: 'lead-read' };
		const res = await runTaskSteps({ task: sampleTask, narration, executor: recordingExecutor(events) });

		expect(res.aborted).toBe(false);

		// Per step the order is exactly narrate → perform → shot.
		for (const step of sampleTask.steps) {
			const stepOps = events.filter((e) => e.id === step.id).map((e) => e.op);
			expect(stepOps).toEqual(['narrate', 'perform', 'shot']);
		}

		// And the steps run in declared order with a single done() at the end.
		const opIndex = (op, id) => events.findIndex((e) => e.op === op && e.id === id);
		expect(opIndex('narrate', 'type')).toBeGreaterThan(opIndex('shot', 'open'));
		expect(opIndex('narrate', 'read')).toBeGreaterThan(opIndex('shot', 'type'));
		expect(events.at(-1)).toEqual({ op: 'done', id: 'sample' });
	});

	it('leads each action with the brain-supplied narration, falling back to the step line', async () => {
		const events = [];
		await runTaskSteps({ task: sampleTask, narration: { open: 'brain line' }, executor: recordingExecutor(events) });
		const lines = Object.fromEntries(events.filter((e) => e.op === 'narrate').map((e) => [e.id, e.line]));
		expect(lines.open).toBe('brain line');            // brain-supplied wins
		expect(lines.type).toBe('Typing the query');      // missing → declarative fallback
	});

	it('passes the read result through to shot() so the result can be narrated', async () => {
		const events = [];
		await runTaskSteps({ task: sampleTask, narration: {}, executor: recordingExecutor(events) });
		const readShot = events.find((e) => e.op === 'shot' && e.id === 'read');
		expect(readShot.result).toBe('EXTRACTED TEXT');
	});

	it('recovers from a failing step (fail(), no shot) and continues the run', async () => {
		const events = [];
		const res = await runTaskSteps({ task: sampleTask, narration: {}, executor: recordingExecutor(events, { failOn: 'type' }) });
		expect(res.aborted).toBe(false);
		const typeOps = events.filter((e) => e.id === 'type').map((e) => e.op);
		expect(typeOps).toEqual(['narrate', 'perform', 'fail']); // failed → fail(), no shot
		// The run still reaches the next step and completes.
		expect(events.some((e) => e.op === 'shot' && e.id === 'read')).toBe(true);
		expect(events.at(-1).op).toBe('done');
	});

	it('stops promptly when the abort signal fires (nobody watching)', async () => {
		const events = [];
		const controller = new AbortController();
		const ex = recordingExecutor(events);
		const slowNarrate = ex.narrate;
		ex.narrate = async (line, step) => { await slowNarrate(line, step); controller.abort(); };
		const res = await runTaskSteps({ task: sampleTask, narration: {}, executor: ex, signal: controller.signal });
		expect(res.aborted).toBe(true);
		expect(events.some((e) => e.op === 'done')).toBe(false); // never completed
	});
});

describe('agent-screen pool — narration JSON parsing', () => {
	it('extracts a JSON object even when wrapped in prose or a code fence', () => {
		expect(parseNarrationJson('```json\n{"open":"Go"}\n```')).toEqual({ open: 'Go' });
		expect(parseNarrationJson('Sure! {"a":"b"} done')).toEqual({ a: 'b' });
		expect(parseNarrationJson('not json at all')).toBeNull();
		expect(parseNarrationJson('')).toBeNull();
	});
});

describe('agent-screen pool — task library', () => {
	it('assigns a stable task per agent, spread across the library', () => {
		const a = pickTask('11111111-1111-1111-1111-111111111111');
		const b = pickTask('11111111-1111-1111-1111-111111111111');
		expect(a.id).toBe(b.id); // deterministic / stable for one agent
		expect(TASKS).toContainEqual(a);
	});

	it('every task is a real, complete, ordered plan ending in a read', () => {
		for (const t of TASKS) {
			expect(t.steps.length).toBeGreaterThanOrEqual(2);
			expect(t.steps[0].kind).toBe('goto');
			expect(t.steps.at(-1).kind).toBe('read');
			for (const s of t.steps) {
				expect(typeof s.id).toBe('string');
				expect(typeof s.narration).toBe('string');
				expect(s.narration.length).toBeGreaterThan(0);
			}
			expect(getTask(t.id)).toBe(t);
		}
	});

	it('$THREE is the only coin — the task library never references another token', () => {
		const src = readFileSync(resolve(__dir, '../workers/agent-screen-pool/tasks/index.js'), 'utf8');
		const forbidden = [/market\s*cap/i, /marketCap/, /trending token/i, /holder count/i, /\$(?!THREE)[A-Z]{2,}/];
		for (const pattern of forbidden) {
			expect(src, `task library must not match ${pattern}`).not.toMatch(pattern);
		}
	});
});

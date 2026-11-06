import { describe, it, expect, beforeEach } from 'vitest';
import { agentBus } from './agent-bus.js';
import { emitRecallFromChat } from './memory-client.js';

describe('emitRecallFromChat (chat done → memory:recalled)', () => {
	beforeEach(() => agentBus.reset());

	it('emits one memory:recalled carrying exactly the server-reported memories', () => {
		const events = [];
		agentBus.on('memory:recalled', (p) => events.push(p));
		const done = {
			type: 'done',
			recalled: [
				{ id: 'm1', type: 'project', tier: 'working', salience: 0.9, snippet: 'likes vivid demos', match: 'context' },
				{ id: 'm2', type: 'user', tier: 'recall', salience: 0.6, snippet: 'based in Lisbon', match: 'semantic' },
			],
			recalledSemantic: true,
			recalledTs: '2026-06-23T10:00:00.000Z',
		};
		const returned = emitRecallFromChat('agent-1', done, 'where am I based?');
		expect(events).toHaveLength(1);
		expect(events[0].agentId).toBe('agent-1');
		expect(events[0].memories.map((m) => m.id)).toEqual(['m1', 'm2']);
		expect(events[0].semantic).toBe(true);
		expect(events[0].query).toBe('where am I based?');
		expect(events[0].ts).toBe('2026-06-23T10:00:00.000Z');
		expect(returned).toHaveLength(2);
	});

	it('emits nothing when the server recalled no memories', () => {
		const events = [];
		agentBus.on('memory:recalled', (p) => events.push(p));
		expect(emitRecallFromChat('agent-1', { type: 'done', recalled: [] })).toEqual([]);
		expect(emitRecallFromChat('agent-1', { type: 'done' })).toEqual([]);
		expect(events).toHaveLength(0);
	});
});

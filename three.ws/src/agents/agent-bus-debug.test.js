// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { agentBus } from './agent-bus.js';
import { mountAgentBusDebug } from './agent-bus-debug.js';

describe('agent-bus debug overlay (the verification surface)', () => {
	beforeEach(() => {
		agentBus.reset();
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	it('mounts a single panel and renders a row per emitted event', () => {
		mountAgentBusDebug();
		mountAgentBusDebug(); // idempotent
		const panels = document.querySelectorAll('#agentbus-debug');
		expect(panels).toHaveLength(1);

		agentBus.emit('agent:changed', { agentId: 'a1', agent: { name: 'Ada' } });
		agentBus.emit('memory:recalled', {
			agentId: 'a1',
			memories: [{ id: 'm1', type: 'user', tier: 'recall', salience: 0.5, snippet: 'hi', match: 'semantic' }],
			semantic: true,
		});

		const rows = document.querySelectorAll('#agentbus-debug .row');
		expect(rows).toHaveLength(2);
		expect(document.querySelector('#agentbus-debug [data-count]').textContent).toBe('2 events');
		// The recall row summarises the count + semantic flag for at-a-glance debugging.
		expect(rows[1].textContent).toContain('1 recalled');
		expect(rows[1].textContent).toContain('semantic');
	});

	it('clears the log on demand', () => {
		mountAgentBusDebug();
		agentBus.emit('mood:changed', { agentId: 'a1', mood: 'calm' });
		expect(document.querySelectorAll('#agentbus-debug .row')).toHaveLength(1);
		document.querySelector('#agentbus-debug [data-clear]').click();
		expect(document.querySelectorAll('#agentbus-debug .row')).toHaveLength(0);
		expect(document.querySelector('#agentbus-debug [data-count]').textContent).toBe('0 events');
	});
});

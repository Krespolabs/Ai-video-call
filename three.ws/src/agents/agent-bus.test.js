import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentBus, AGENT_EVENTS, EVENTS, WILDCARD } from './agent-bus.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('agent-bus contract', () => {
	beforeEach(() => agentBus.reset());

	it('exposes the nine shared event types in both forms', () => {
		expect(AGENT_EVENTS).toHaveLength(9);
		expect(AGENT_EVENTS).toContain('memory:recalled');
		expect(EVENTS.MEMORY_RECALLED).toBe('memory:recalled');
		expect(WILDCARD).toBe('*');
	});

	it('delivers an emitted payload to a typed subscriber', () => {
		const seen = [];
		agentBus.on('memory:added', (p) => seen.push(p));
		agentBus.emit('memory:added', { agentId: 'a1', memory: { id: 'm1' } });
		expect(seen).toHaveLength(1);
		expect(seen[0].agentId).toBe('a1');
		expect(seen[0].memory.id).toBe('m1');
	});

	it('passes through a server-provided ts and stamps a fallback otherwise', () => {
		const got = [];
		agentBus.on('mood:changed', (p) => got.push(p.ts));
		const serverTs = '2026-01-02T03:04:05.000Z';
		agentBus.emit('mood:changed', { agentId: 'a1', mood: 'calm', ts: serverTs });
		agentBus.emit('mood:changed', { agentId: 'a1', mood: 'curious' });
		expect(got[0]).toBe(serverTs);
		expect(typeof got[1]).toBe('string');
		expect(() => new Date(got[1]).toISOString()).not.toThrow();
	});

	it('freezes the delivered payload so subscribers cannot corrupt shared state', () => {
		let captured;
		agentBus.on('agent:changed', (p) => (captured = p));
		agentBus.emit('agent:changed', { agentId: 'a1', agent: null });
		expect(Object.isFrozen(captured)).toBe(true);
	});

	it('rejects unknown event types on both emit and on', () => {
		expect(() => agentBus.emit('not:real', {})).toThrow(/unknown event/);
		expect(() => agentBus.on('also:fake', () => {})).toThrow(/unknown event/);
	});

	it('unsubscribes via the returned function', () => {
		const seen = [];
		const off = agentBus.on('memory:added', (p) => seen.push(p));
		agentBus.emit('memory:added', { agentId: 'a' });
		off();
		agentBus.emit('memory:added', { agentId: 'a' });
		expect(seen).toHaveLength(1);
	});

	it('once fires exactly once', () => {
		let n = 0;
		agentBus.once('dream:created', () => (n += 1));
		agentBus.emit('dream:created', { agentId: 'a', dreamId: 'd', insight: 'x' });
		agentBus.emit('dream:created', { agentId: 'a', dreamId: 'd2', insight: 'y' });
		expect(n).toBe(1);
	});

	it('wildcard subscribers see every event with its type', () => {
		const log = [];
		agentBus.on(WILDCARD, (p, type) => log.push([type, p.agentId]));
		agentBus.emit('memory:added', { agentId: 'a1' });
		agentBus.emit('mood:changed', { agentId: 'a2', mood: 'up' });
		expect(log).toEqual([
			['memory:added', 'a1'],
			['mood:changed', 'a2'],
		]);
	});

	it('isolates a throwing subscriber from the others and the emitter', () => {
		const seen = [];
		agentBus.on('action:taken', () => {
			throw new Error('boom');
		});
		agentBus.on('action:taken', (p) => seen.push(p.kind));
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => agentBus.emit('action:taken', { agentId: 'a', kind: 'alert', summary: 's' })).not.toThrow();
		expect(seen).toEqual(['alert']);
		errSpy.mockRestore();
	});

	describe('replay (late-mounting surfaces catch up)', () => {
		it('last() returns the most recent payload, or null', () => {
			expect(agentBus.last('brain:updated')).toBeNull();
			agentBus.emit('brain:updated', { agentId: 'a', change: 'first' });
			agentBus.emit('brain:updated', { agentId: 'a', change: 'second' });
			expect(agentBus.last('brain:updated').change).toBe('second');
		});

		it('replay:true delivers only the last payload on subscribe', () => {
			agentBus.emit('memory:added', { agentId: 'a', memory: { id: 'm1' } });
			agentBus.emit('memory:added', { agentId: 'a', memory: { id: 'm2' } });
			const seen = [];
			agentBus.on('memory:added', (p) => seen.push(p.memory.id), { replay: true });
			expect(seen).toEqual(['m2']);
		});

		it("replay:'all' delivers the retained backlog oldest→newest", () => {
			agentBus.emit('memory:added', { agentId: 'a', memory: { id: 'm1' } });
			agentBus.emit('memory:added', { agentId: 'a', memory: { id: 'm2' } });
			const seen = [];
			agentBus.on('memory:added', (p) => seen.push(p.memory.id), { replay: 'all' });
			expect(seen).toEqual(['m1', 'm2']);
		});

		it('backlog() exposes history without subscribing', () => {
			agentBus.emit('mood:changed', { agentId: 'a', mood: 'a' });
			agentBus.emit('mood:changed', { agentId: 'a', mood: 'b' });
			expect(agentBus.backlog('mood:changed').map((p) => p.mood)).toEqual(['a', 'b']);
		});
	});

	describe('backpressure (throttle coalescing)', () => {
		it('delivers the leading event immediately and a single trailing event with the latest payload', async () => {
			const seen = [];
			agentBus.on('memory:added', (p) => seen.push(p.memory.id), { throttleMs: 20 });
			agentBus.emit('memory:added', { agentId: 'a', memory: { id: 'A' } });
			agentBus.emit('memory:added', { agentId: 'a', memory: { id: 'B' } });
			agentBus.emit('memory:added', { agentId: 'a', memory: { id: 'C' } });
			// Leading 'A' fired synchronously; B and C are coalesced.
			expect(seen).toEqual(['A']);
			await wait(40);
			// Trailing delivers only the most recent (C); B was dropped.
			expect(seen).toEqual(['A', 'C']);
		});
	});

	it('auto-unsubscribes when an AbortSignal fires', () => {
		const seen = [];
		const ctrl = new AbortController();
		agentBus.on('agent:changed', (p) => seen.push(p.agentId), { signal: ctrl.signal });
		agentBus.emit('agent:changed', { agentId: 'a1', agent: null });
		ctrl.abort();
		agentBus.emit('agent:changed', { agentId: 'a2', agent: null });
		expect(seen).toEqual(['a1']);
	});
});

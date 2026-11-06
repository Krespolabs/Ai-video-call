// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The engine resolves the active agent and persists over the network — mock both
// so the test exercises the real signal→state→emit logic in isolation.
const ACTIVE_ID = '11111111-1111-4111-8111-111111111111';
let activeCb = null;
vi.mock('../src/agents/active-agent.js', () => ({
	onActiveAgentChange: (cb) => { activeCb = cb; return () => {}; },
	getActiveAgentId: () => ACTIVE_ID,
	peekActiveAgent: () => ({ id: ACTIVE_ID, meta: {} }),
}));
const apiFetch = vi.fn(async () => ({ ok: true, json: async () => ({ history: [] }) }));
vi.mock('../src/api.js', () => ({ apiFetch: (...a) => apiFetch(...a) }));

const { moodEngine } = await import('../src/agents/mood-engine.js');
const { agentBus, EVENTS } = await import('../src/agents/agent-bus.js');
const { BASELINE } = await import('../src/agents/mood-model.js');

describe('mood-engine', () => {
	// NB: do not call agentBus.reset() — the engine subscribes to the bus once at
	// import; resetting would orphan it. We isolate via _adoptAgent (resets mood
	// to baseline) + clearing storage/mocks instead.
	beforeEach(() => {
		localStorage.clear();
		apiFetch.mockClear();
		moodEngine._adoptAgent(ACTIVE_ID, { id: ACTIVE_ID, meta: {} });
		moodEngine.sensitivity = 0.8;
	});

	it('emits mood:changed for the active agent on a real signal', () => {
		const seen = [];
		agentBus.on(EVENTS.MOOD_CHANGED, (p) => seen.push(p));
		agentBus.emit(EVENTS.MEMORY_ADDED, { agentId: ACTIVE_ID, memory: { id: 'm1', salience: 0.9 } });
		expect(seen.length).toBeGreaterThan(0);
		const last = seen[seen.length - 1];
		expect(last.agentId).toBe(ACTIVE_ID);
		expect(last.mood).toBeTruthy();
		expect(typeof last.valence).toBe('number');
	});

	it('a positive memory lifts valence above baseline', () => {
		moodEngine._adoptAgent(ACTIVE_ID, { id: ACTIVE_ID, meta: {} });
		moodEngine.sensitivity = 0.8;
		agentBus.emit(EVENTS.MEMORY_ADDED, { agentId: ACTIVE_ID, memory: { id: 'm2', salience: 1 } });
		expect(moodEngine.getState().valence).toBeGreaterThan(BASELINE.valence);
		expect(moodEngine.recentSignals()[0].source).toBe('memory:added');
	});

	it('observeChat moves mood negative on a negative message', () => {
		moodEngine._adoptAgent(ACTIVE_ID, { id: ACTIVE_ID, meta: {} });
		moodEngine.sensitivity = 0.8;
		const before = moodEngine.getState().valence;
		moodEngine.observeChat(ACTIVE_ID, 'this is broken and terrible, a total failure and a disaster', 'user');
		expect(moodEngine.getState().valence).toBeLessThan(before);
	});

	it('ignores signals for a different agent', () => {
		moodEngine._adoptAgent(ACTIVE_ID, { id: ACTIVE_ID, meta: {} });
		moodEngine.sensitivity = 0.8;
		const before = moodEngine.getState();
		agentBus.emit(EVENTS.MEMORY_ADDED, { agentId: '99999999-9999-4999-8999-999999999999', memory: { id: 'x', salience: 1 } });
		expect(moodEngine.getState()).toEqual(before);
	});

	it('a stoic agent (sensitivity 0) never leaves baseline on a signal', async () => {
		moodEngine._adoptAgent(ACTIVE_ID, { id: ACTIVE_ID, meta: {} });
		await moodEngine.setSensitivity(0);
		const before = moodEngine.getState();
		agentBus.emit(EVENTS.ACTION_TAKEN, { agentId: ACTIVE_ID, summary: 'Handled an alert' });
		expect(moodEngine.getState().valence).toBeCloseTo(before.valence);
		expect(moodEngine.getState().arousal).toBeCloseTo(before.arousal);
	});

	it('restores a persisted snapshot from local storage, decayed by elapsed time', () => {
		const old = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
		localStorage.setItem('threews:mood:' + ACTIVE_ID, JSON.stringify({
			valence: 0.9, arousal: 0.9, sensitivity: 0.5, updated_at: old,
		}));
		moodEngine._adoptAgent(ACTIVE_ID, { id: ACTIVE_ID, meta: {} });
		const s = moodEngine.getState();
		// Cooled from the 0.9/0.9 spike but not yet back to baseline.
		expect(s.valence).toBeLessThan(0.9);
		expect(s.valence).toBeGreaterThan(BASELINE.valence);
		expect(moodEngine.getSensitivity()).toBeCloseTo(0.5);
	});

	it('persists to the mood API (debounced) after a real signal', async () => {
		vi.useFakeTimers();
		moodEngine._adoptAgent(ACTIVE_ID, { id: ACTIVE_ID, meta: {} });
		moodEngine.sensitivity = 0.8;
		apiFetch.mockClear();
		agentBus.emit(EVENTS.DREAM_CREATED, { agentId: ACTIVE_ID, statement: 'a satisfying insight' });
		await vi.advanceTimersByTimeAsync(3000);
		const moodPost = apiFetch.mock.calls.find((c) => String(c[0]).endsWith(`/api/agents/${ACTIVE_ID}/mood`));
		expect(moodPost).toBeTruthy();
		expect(moodPost[1].method).toBe('POST');
		const body = JSON.parse(moodPost[1].body);
		expect(body.source).toBe('dream:insight');
		expect(typeof body.valence).toBe('number');
		vi.useRealTimers();
	});
});

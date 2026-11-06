/**
 * Live Q&A Concierge — routing + context-building (pure logic).
 *
 * The /agent-screen task bar is one input that either asks the agent a live
 * question or (for an owner) queues a background task. These tests pin the pure
 * decisions behind that branch so the client and server can never drift:
 *   - classifyTaskInput: who-asks-vs-who-queues
 *   - pickProvider:      free-tier clamp for anonymous askers
 *   - buildSystemPrompt: persona + $THREE-only policy framing
 *   - parseTurn / buildAskMessages: prior-turn context reconstruction
 */

import { describe, it, expect } from 'vitest';
import { classifyTaskInput, ensureSessionId } from '../src/shared/ask-routing.js';
import {
	pickProvider, buildSystemPrompt, parseTurn, buildAskMessages,
} from '../api/agent-ask.js';

describe('classifyTaskInput — ask vs queue', () => {
	it('a non-owner can only ask, even if a task mode leaks in', () => {
		expect(classifyTaskInput({ isOwner: false })).toBe('ask');
		expect(classifyTaskInput({ isOwner: false, mode: 'task' })).toBe('ask');
	});

	it('defaults to ask for an owner who has not switched modes', () => {
		expect(classifyTaskInput({ isOwner: true })).toBe('ask');
		expect(classifyTaskInput({ isOwner: true, mode: 'ask' })).toBe('ask');
		expect(classifyTaskInput({ isOwner: true, mode: null })).toBe('ask');
	});

	it('queues only when an owner explicitly picks task mode', () => {
		expect(classifyTaskInput({ isOwner: true, mode: 'task' })).toBe('task');
	});

	it('is safe with no arguments', () => {
		expect(classifyTaskInput()).toBe('ask');
	});
});

describe('ensureSessionId — per-tab continuity', () => {
	function memStore() {
		const m = new Map();
		return {
			getItem: (k) => (m.has(k) ? m.get(k) : null),
			setItem: (k, v) => m.set(k, String(v)),
		};
	}

	it('mints an id once and reuses it on subsequent calls', () => {
		const store = memStore();
		let n = 0;
		const make = () => `id-${++n}`;
		const first = ensureSessionId(store, make);
		const second = ensureSessionId(store, make);
		expect(first).toBe('id-1');
		expect(second).toBe('id-1'); // reused, not regenerated
	});

	it('falls back to a fresh id when storage throws', () => {
		const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => {} };
		const id = ensureSessionId(broken, () => 'fallback');
		expect(id).toBe('fallback');
	});
});

describe('pickProvider — anonymous free-tier clamp', () => {
	it('honours the configured provider for an authenticated owner', () => {
		expect(pickProvider('claude-opus-4-7', { authed: true })).toBe('claude-opus-4-7');
	});

	it('clamps an anonymous asker off a paid model to the free default', () => {
		expect(pickProvider('claude-opus-4-7', { authed: false })).toBe('gpt-oss-120b');
	});

	it('lets an anonymous asker keep an already-free configured model', () => {
		expect(pickProvider('nvidia-nemotron-nano', { authed: false })).toBe('nvidia-nemotron-nano');
	});

	it('defaults a missing/blank provider to the free default', () => {
		expect(pickProvider(null, { authed: true })).toBe('gpt-oss-120b');
		expect(pickProvider('', { authed: false })).toBe('gpt-oss-120b');
		expect(pickProvider('   ', { authed: true })).toBe('gpt-oss-120b');
	});
});

describe('buildSystemPrompt — persona + policy', () => {
	it('uses the compiled persona when present', () => {
		const p = buildSystemPrompt({ name: 'Nova', persona_prompt: 'You are a witty market sage.' });
		expect(p).toContain('You are a witty market sage.');
	});

	it('falls back to name + description when no persona', () => {
		const p = buildSystemPrompt({ name: 'Scout', description: 'A research agent.' });
		expect(p).toContain('Scout');
		expect(p).toContain('A research agent.');
	});

	it('always layers the concierge framing and the $THREE-only rule', () => {
		const p = buildSystemPrompt({ name: 'Scout' });
		expect(p.toLowerCase()).toContain('first person');
		expect(p).toContain('$THREE');
		expect(p).toContain('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
		expect(p).toContain('no other coins');
	});

	it('survives an empty/garbage agent record', () => {
		expect(() => buildSystemPrompt(null)).not.toThrow();
		expect(buildSystemPrompt({}).length).toBeGreaterThan(0);
	});
});

describe('parseTurn / buildAskMessages — context reconstruction', () => {
	it('round-trips a stored turn', () => {
		const stored = 'Q: what do you trade?\n\nA: mostly $THREE momentum.';
		expect(parseTurn(stored)).toEqual({ q: 'what do you trade?', a: 'mostly $THREE momentum.' });
	});

	it('returns null for malformed or half-empty turns', () => {
		expect(parseTurn('no markers here')).toBeNull();
		expect(parseTurn('Q: only a question\n\nA: ')).toBeNull();
		expect(parseTurn('')).toBeNull();
		expect(parseTurn(null)).toBeNull();
	});

	it('builds alternating messages ending in the new question', () => {
		const prior = [
			{ content: 'Q: who are you?\n\nA: I am Scout.' },
			{ content: 'Q: what do you do?\n\nA: I research tokens.' },
		];
		const msgs = buildAskMessages(prior, 'which made the most money?');
		expect(msgs).toEqual([
			{ role: 'user', content: 'who are you?' },
			{ role: 'assistant', content: 'I am Scout.' },
			{ role: 'user', content: 'what do you do?' },
			{ role: 'assistant', content: 'I research tokens.' },
			{ role: 'user', content: 'which made the most money?' },
		]);
	});

	it('skips unparseable prior turns but keeps the new question', () => {
		const msgs = buildAskMessages([{ content: 'garbage' }, 'also garbage'], 'hello?');
		expect(msgs).toEqual([{ role: 'user', content: 'hello?' }]);
	});

	it('handles no prior turns', () => {
		expect(buildAskMessages(null, 'first question')).toEqual([
			{ role: 'user', content: 'first question' },
		]);
	});
});

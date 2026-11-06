// Unit tests for the Ambient World DJ script (Brief 22).
//
// The DJ turns world snapshots into calm host lines. Two properties matter most
// and are easy to regress: the minimum-gap pacing (it must never get chatty) and
// that lines are real, templated reactions to world events (sunrise, dusk, a
// crowd) rather than random filler — and that none of them ever names a coin.

import { describe, it, expect } from 'vitest';
import { createDjScript, DJ_MIN_GAP_MS } from '../src/agent-screen-dj.js';

const state = (over = {}) => ({ phase: 0.5, pedCount: 0, crowd: 0, biomeLabel: 'Verdant Meadow', landmark: 'the plaza', ...over });

describe('createDjScript pacing', () => {
	it('emits the first line immediately, then nothing until the gap elapses', () => {
		const dj = createDjScript({ minGapMs: 28_000 });
		const first = dj.observe(state(), 0);
		expect(first).not.toBeNull();
		expect(dj.observe(state(), 1_000)).toBeNull();
		expect(dj.observe(state(), 27_999)).toBeNull();
		expect(dj.observe(state(), 28_000)).not.toBeNull();
	});

	it('never spaces two emitted lines closer than the min gap over a long run', () => {
		const dj = createDjScript({ minGapMs: 28_000 });
		let now = 0;
		let lastEmit = -Infinity;
		// Hammer it far more often than the gap, with a changing world.
		for (let i = 0; i < 500; i++) {
			now += 3_000;
			const line = dj.observe(state({ phase: (i / 50) % 1, crowd: (i % 7) / 6, pedCount: i % 4 }), now);
			if (line) {
				expect(now - lastEmit).toBeGreaterThanOrEqual(28_000);
				lastEmit = now;
			}
		}
	});

	it('defaults the min gap to DJ_MIN_GAP_MS', () => {
		const dj = createDjScript();
		expect(dj.observe(state(), 0)).not.toBeNull();
		expect(dj.observe(state(), DJ_MIN_GAP_MS - 1)).toBeNull();
		expect(dj.observe(state(), DJ_MIN_GAP_MS)).not.toBeNull();
	});
});

describe('createDjScript events', () => {
	it('templates the world name and landmark into the line', () => {
		const dj = createDjScript({ minGapMs: 0, place: 'Dune Sea', landmark: 'the dunes' });
		const line = dj.observe(state({ phase: 0.5, biomeLabel: 'Dune Sea', landmark: 'the dunes' }), 0);
		expect(line.text).toMatch(/Dune Sea|the dunes/);
		expect(line.type).toBe('activity');
		expect(typeof line.mood).toBe('string');
	});

	it('announces a sunrise when the sky crosses into the sunrise band', () => {
		const dj = createDjScript({ minGapMs: 0 });
		dj.observe(state({ phase: 0.1 }), 0); // night — primes the band memory
		const line = dj.observe(state({ phase: 0.25 }), 1);
		expect(line.event).toBe('sunrise');
	});

	it('calls golden hour as its own beat', () => {
		const dj = createDjScript({ minGapMs: 0 });
		dj.observe(state({ phase: 0.5 }), 0); // day
		const line = dj.observe(state({ phase: 0.7 }), 1);
		expect(line.event).toBe('goldenHour');
	});

	it('reacts to the plaza filling up with a crowd line', () => {
		const dj = createDjScript({ minGapMs: 0 });
		dj.observe(state({ phase: 0.5, crowd: 0 }), 0); // quiet — prime
		const line = dj.observe(state({ phase: 0.5, crowd: 0.8 }), 1);
		expect(line.event).toBe('zoneBusy');
	});

	it('falls back to calm idle ambiance when nothing changed', () => {
		const dj = createDjScript({ minGapMs: 0 });
		dj.observe(state({ phase: 0.5 }), 0);
		const line = dj.observe(state({ phase: 0.5 }), 1);
		expect(line.event).toBe('idleAmbiance');
	});

	it('rotates phrasings deterministically (no Math.random)', () => {
		const a = createDjScript({ minGapMs: 0 });
		const b = createDjScript({ minGapMs: 0 });
		const seq = [];
		for (let i = 0; i < 5; i++) seq.push([a.observe(state(), i).text, b.observe(state(), i).text]);
		for (const [x, y] of seq) expect(x).toBe(y);
	});
});

describe('createDjScript brand safety', () => {
	it('never mentions any coin or token in any phrasing', () => {
		const dj = createDjScript({ minGapMs: 0, place: 'Neon Expanse', landmark: 'the expanse' });
		const seen = new Set();
		// Drive every event band many times to exhaust the template banks.
		const phases = [0.1, 0.25, 0.5, 0.7, 0.75, 0.9];
		for (let i = 0; i < 200; i++) {
			const line = dj.observe(state({ phase: phases[i % phases.length], crowd: (i % 3) / 2, pedCount: i % 5 }), i);
			if (line) seen.add(line.text.toLowerCase());
		}
		for (const text of seen) {
			expect(text).not.toMatch(/\$[a-z]/i);        // no $TICKER
			expect(text).not.toMatch(/token|coin|\bbuy\b|\bsell\b|pump|market cap/i);
		}
		expect(seen.size).toBeGreaterThan(3);
	});
});

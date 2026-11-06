// Pure-logic coverage for the floating-emoji reaction overlay simulation core.
// No DOM is touched — only the deterministic spawn/advance/cap/burst math and the
// ReactionField that the canvas mount drives.

import { describe, it, expect } from 'vitest';
import {
	spawnParticle,
	advanceParticle,
	particleOpacity,
	alive,
	burstCount,
	capParticles,
	ReactionField,
	REACTION_EMOJI,
} from '../src/reaction-overlay.js';

describe('spawnParticle', () => {
	it('is deterministic for a given seed', () => {
		const a = spawnParticle('🔥', 5);
		const b = spawnParticle('🔥', 5);
		expect(a).toEqual(b);
	});

	it('launches near the lower centre, fully transparent, at the bottom', () => {
		const p = spawnParticle('🚀', 3);
		expect(p.emoji).toBe('🚀');
		expect(p.y).toBe(0);
		expect(p.opacity).toBe(0);
		expect(p.x0).toBeGreaterThanOrEqual(0.28);
		expect(p.x0).toBeLessThanOrEqual(0.72);
		expect(p.ttl).toBeGreaterThan(0);
	});

	it('spreads particles across seeds so a burst does not stack exactly', () => {
		const xs = new Set([0, 1, 2, 3, 4].map((s) => spawnParticle('❤️', s).x0));
		expect(xs.size).toBeGreaterThan(1);
	});
});

describe('particleOpacity', () => {
	it('is zero at the endpoints and full in the middle', () => {
		expect(particleOpacity(0)).toBe(0);
		expect(particleOpacity(1)).toBe(0);
		expect(particleOpacity(0.5)).toBe(1);
	});

	it('fades in then out', () => {
		expect(particleOpacity(0.06)).toBeGreaterThan(0);
		expect(particleOpacity(0.06)).toBeLessThan(1);
		expect(particleOpacity(0.9)).toBeGreaterThan(0);
		expect(particleOpacity(0.9)).toBeLessThan(1);
	});
});

describe('advanceParticle', () => {
	it('rises monotonically and dies after its ttl', () => {
		const p = spawnParticle('👏', 1);
		const ttl = p.ttl;
		advanceParticle(p, ttl * 0.25);
		const y1 = p.y;
		advanceParticle(p, ttl * 0.25);
		expect(p.y).toBeGreaterThan(y1);
		expect(alive(p)).toBe(true);
		advanceParticle(p, ttl); // push well past end of life
		expect(alive(p)).toBe(false);
	});

	it('keeps a particle visible partway through its life', () => {
		const p = spawnParticle('😂', 2);
		advanceParticle(p, p.ttl * 0.5);
		expect(p.opacity).toBeGreaterThan(0);
		expect(p.size).toBeGreaterThan(0.6);
	});
});

describe('burstCount', () => {
	it('clamps to the per-burst cap and never drops below one', () => {
		expect(burstCount(1, 12)).toBe(1);
		expect(burstCount(50, 12)).toBe(12);
		expect(burstCount(0, 12)).toBe(1);
		expect(burstCount(7, 12)).toBe(7);
	});
});

describe('capParticles', () => {
	it('evicts the oldest, keeping the newest up to max', () => {
		const list = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
		capParticles(list, 3);
		expect(list.map((p) => p.id)).toEqual([2, 3, 4]);
	});

	it('leaves a short list untouched', () => {
		const list = [{ id: 0 }, { id: 1 }];
		capParticles(list, 8);
		expect(list).toHaveLength(2);
	});
});

describe('ReactionField', () => {
	it('spawns a clamped burst and reports the count', () => {
		const field = new ReactionField({ max: 64, perBurst: 5 });
		const spawned = field.add('🔥', 100);
		expect(spawned).toBe(5);
		expect(field.count).toBe(5);
	});

	it('never exceeds the field cap across many bursts', () => {
		const field = new ReactionField({ max: 10, perBurst: 6 });
		for (let i = 0; i < 20; i++) field.add('🚀', 6);
		expect(field.count).toBeLessThanOrEqual(10);
	});

	it('drops dead particles on step', () => {
		const field = new ReactionField({ max: 32, perBurst: 4 });
		field.add('❤️', 4);
		expect(field.count).toBe(4);
		field.step(10_000); // longer than any ttl
		expect(field.count).toBe(0);
	});

	it('ignores an empty emoji', () => {
		const field = new ReactionField();
		expect(field.add('', 3)).toBe(0);
		expect(field.count).toBe(0);
	});
});

describe('REACTION_EMOJI', () => {
	it('is the curated, frozen client allowlist', () => {
		expect(REACTION_EMOJI).toEqual(['🔥', '❤️', '👏', '🚀', '😂']);
		expect(Object.isFrozen(REACTION_EMOJI)).toBe(true);
	});
});

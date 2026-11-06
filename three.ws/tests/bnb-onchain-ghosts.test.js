/**
 * On-chain presence ghost-state tracker (src/bnb/onchain-ghosts.js) — unit
 * tests. Pure logic only: feed timestamped positions, tick(dt), assert
 * smooth intermediate frames and stale-player eviction. No THREE.js, no
 * network, no DOM.
 */

import { describe, it, expect } from 'vitest';
import { createGhostTracker, GHOST_STALE_MS } from '../src/bnb/onchain-ghosts.js';

describe('createGhostTracker — upsert + interpolation', () => {
	it('a first sighting snaps instantly (no lerp-in from the origin)', () => {
		const g = createGhostTracker({ now: () => 1000 });
		g.upsert('0xAAA', { x: 10, y: 0, z: -5, facing: 100 });
		const entry = g.get('0xaaa');
		expect(entry).toMatchObject({ x: 10, y: 0, z: -5, facing: 100 });
	});

	it('lowercases the player key so case-inconsistent addresses collapse to one ghost', () => {
		const g = createGhostTracker({ now: () => 1000 });
		g.upsert('0xAbCdEf', { x: 1, y: 2, z: 3, facing: 0 });
		g.upsert('0xabcdef', { x: 5, y: 5, z: 5, facing: 0 });
		expect(g.size).toBe(1);
	});

	it('tick() moves current position toward the target, converging over several frames', () => {
		let now = 0;
		const g = createGhostTracker({ now: () => now, lerp: 0.22 });
		g.upsert('0xaaa', { x: 0, y: 0, z: 0, facing: 0 }, 0);
		g.upsert('0xaaa', { x: 100, y: 0, z: 0, facing: 0 }, 10); // new target far away
		now = 10;
		const before = g.get('0xaaa').x;
		g.tick(1 / 60, 10);
		const afterOneFrame = g.get('0xaaa').x;
		expect(afterOneFrame).toBeGreaterThan(before);
		expect(afterOneFrame).toBeLessThan(100);
		for (let i = 0; i < 60; i++) g.tick(1 / 60, 10 + i);
		expect(g.get('0xaaa').x).toBeGreaterThan(99); // converges close to the target
	});

	it('facing interpolates the SHORT way around the wrap (e.g. 350° → 10° goes forward through 0°, not backward through 180°)', () => {
		let now = 0;
		const g = createGhostTracker({ now: () => now, lerp: 0.5, facingRange: 36000 });
		g.upsert('0xaaa', { x: 0, y: 0, z: 0, facing: 35000 }, 0); // 350.00°
		g.upsert('0xaaa', { x: 0, y: 0, z: 0, facing: 1000 }, 0); // target 10.00°
		g.tick(1, 0);
		const facing = g.get('0xaaa').facing;
		// Short path from 350° to 10° passes through 0°/360°, landing near 0 or near
		// 35999 — NOT anywhere near 180° (which the naive/long-way interpolation
		// would produce).
		const distanceFromWrapPoint = Math.min(facing, 36000 - facing);
		expect(distanceFromWrapPoint).toBeLessThan(18000);
	});

	it('tick() drops (and reports) a player who has gone stale', () => {
		let now = 0;
		const g = createGhostTracker({ now: () => now, staleMs: GHOST_STALE_MS });
		g.upsert('0xaaa', { x: 0, y: 0, z: 0, facing: 0 }, 0);
		now = GHOST_STALE_MS + 1;
		const dead = g.tick(1 / 60, now);
		expect(dead).toEqual(['0xaaa']);
		expect(g.size).toBe(0);
	});

	it('tick() keeps a player who moved recently even under a custom staleMs', () => {
		let now = 0;
		const g = createGhostTracker({ now: () => now, staleMs: 2000 });
		g.upsert('0xaaa', { x: 0, y: 0, z: 0, facing: 0 }, 0);
		now = 1000;
		const dead = g.tick(1 / 60, now);
		expect(dead).toEqual([]);
		expect(g.size).toBe(1);
	});

	it('remove() explicitly evicts a player (e.g. a real-time Left event) without waiting for staleness', () => {
		const g = createGhostTracker({ now: () => 0 });
		g.upsert('0xaaa', { x: 0, y: 0, z: 0, facing: 0 });
		expect(g.size).toBe(1);
		expect(g.remove('0xAAA')).toBe(true); // case-insensitive
		expect(g.size).toBe(0);
	});

	it('clear() empties every tracked ghost', () => {
		const g = createGhostTracker({ now: () => 0 });
		g.upsert('0xaaa', { x: 0, y: 0, z: 0, facing: 0 });
		g.upsert('0xbbb', { x: 1, y: 1, z: 1, facing: 0 });
		g.clear();
		expect(g.size).toBe(0);
	});

	it('values() iterates every live ghost with its player key intact', () => {
		const g = createGhostTracker({ now: () => 0 });
		g.upsert('0xaaa', { x: 1, y: 2, z: 3, facing: 0 });
		const all = [...g.values()];
		expect(all).toHaveLength(1);
		expect(all[0].player).toBe('0xaaa');
	});
});

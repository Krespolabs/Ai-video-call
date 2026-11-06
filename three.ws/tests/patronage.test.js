// Patronage — the pure tier/progress/season/entitlement math that decides what a
// supporter's REAL on-chain support unlocks. The DB aggregation lives behind these
// functions; here we pin the documented thresholds and the gating logic so a
// refactor can't silently move a tier boundary or hand out an unearned perk.

import { describe, it, expect } from 'vitest';
import {
	PATRON_LEVELS,
	levelForUsd,
	levelIndex,
	nextLevelForUsd,
	progressForUsd,
	currentSeason,
	entitledPerks,
} from '../api/_lib/patronage.js';

describe('levelForUsd · documented thresholds', () => {
	it('is null below any support and Supporter at the first cent', () => {
		expect(levelForUsd(0)).toBe(null);
		expect(levelForUsd(-5)).toBe(null);
		expect(levelForUsd(0.01).key).toBe('supporter');
		expect(levelForUsd(9.99).key).toBe('supporter');
	});

	it('promotes exactly at $10 / $50 / $250', () => {
		expect(levelForUsd(10).key).toBe('patron');
		expect(levelForUsd(49.99).key).toBe('patron');
		expect(levelForUsd(50).key).toBe('champion');
		expect(levelForUsd(249.99).key).toBe('champion');
		expect(levelForUsd(250).key).toBe('benefactor');
		expect(levelForUsd(1_000_000).key).toBe('benefactor');
	});

	it('exposes a strictly increasing, ordered ladder', () => {
		const mins = PATRON_LEVELS.map((l) => l.minUsd);
		expect(mins).toEqual([...mins].sort((a, b) => a - b));
		expect(levelIndex('supporter')).toBe(0);
		expect(levelIndex('benefactor')).toBe(PATRON_LEVELS.length - 1);
	});
});

describe('progressForUsd · progress toward the next tier', () => {
	it('reports the next tier and the remaining dollars', () => {
		const p = progressForUsd(10); // a fresh Patron, $40 from Champion
		expect(p.current.key).toBe('patron');
		expect(p.next.key).toBe('champion');
		expect(p.remainingUsd).toBeCloseTo(40, 6);
		expect(p.pct).toBeGreaterThanOrEqual(0);
		expect(p.pct).toBeLessThanOrEqual(1);
	});

	it('caps out at the top tier with no next level', () => {
		const p = progressForUsd(500);
		expect(p.next).toBe(null);
		expect(p.pct).toBe(1);
		expect(p.remainingUsd).toBe(0);
	});

	it('points an unsupported wallet at Supporter', () => {
		expect(nextLevelForUsd(0).key).toBe('supporter');
	});
});

describe('entitledPerks · server-side gating', () => {
	const perks = [
		{ id: 'a', isActive: true, thresholdUsd: 0, perkType: 'badge' },
		{ id: 'b', isActive: true, thresholdUsd: 10, perkType: 'greeting' },
		{ id: 'c', isActive: true, thresholdUsd: 50, perkType: 'skill' },
		{ id: 'd', isActive: false, thresholdUsd: 5, perkType: 'lore' },
	];

	it('grants only perks whose threshold the support clears', () => {
		expect(entitledPerks(perks, 0).map((p) => p.id)).toEqual([]); // $0 earns nothing
		expect(entitledPerks(perks, 9.99).map((p) => p.id)).toEqual(['a']);
		expect(entitledPerks(perks, 10).map((p) => p.id)).toEqual(['a', 'b']);
		expect(entitledPerks(perks, 100).map((p) => p.id)).toEqual(['a', 'b', 'c']);
	});

	it('never grants an inactive perk, even when the threshold is met', () => {
		expect(entitledPerks(perks, 1000).find((p) => p.id === 'd')).toBeUndefined();
	});
});

describe('currentSeason · monthly epoch', () => {
	it('derives a UTC month window from a fixed date', () => {
		const s = currentSeason(new Date('2026-06-23T12:00:00Z'));
		expect(s.key).toBe('2026-06');
		expect(s.startsAt).toBe('2026-06-01T00:00:00.000Z');
		expect(s.endsAt).toBe('2026-07-01T00:00:00.000Z');
	});

	it('rolls the year over at December', () => {
		const s = currentSeason(new Date('2026-12-31T23:59:59Z'));
		expect(s.key).toBe('2026-12');
		expect(s.endsAt).toBe('2027-01-01T00:00:00.000Z');
	});
});

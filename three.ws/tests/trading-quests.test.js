/**
 * Daily trading quests (api/_lib/trading-quests.js): the pure scoring that turns
 * a day's proven events into quest progress, the daily clear, the clear streak,
 * and XP levels. Awards are insert-only, so an award already made must stay made
 * even when a later read counts fewer rows.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', () => ({ sql: () => Promise.resolve([]) }));

const Q = await import('../api/_lib/trading-quests.js');

describe('evaluateQuests', () => {
	it('scores each quest against its target and caps progress at the target', () => {
		const ev = Q.evaluateQuests({ trades: 5, forks: 0, ghosts: 1, acted: 0, green: 0 });
		const byCode = Object.fromEntries(ev.quests.map((q) => [q.code, q]));
		expect(byCode.trades_3).toMatchObject({ progress: 3, done: true });
		expect(byCode.ghost_new).toMatchObject({ progress: 1, done: true });
		expect(byCode.fork_trade).toMatchObject({ progress: 0, done: false });
		expect(ev.done_count).toBe(2);
		expect(ev.cleared).toBe(false);
	});

	it('clears the day at three quests', () => {
		const ev = Q.evaluateQuests({ trades: 3, forks: 1, ghosts: 1 });
		expect(ev.done_count).toBe(3);
		expect(ev.cleared).toBe(true);
	});

	it('keeps an award already made even if the underlying count drops', () => {
		const ev = Q.evaluateQuests({ trades: 1 }, ['trades_3', 'daily_clear']);
		const trades = ev.quests.find((q) => q.code === 'trades_3');
		expect(trades).toMatchObject({ progress: 3, done: true });
		expect(ev.cleared).toBe(true);
	});

	it('treats missing counts as zero', () => {
		const ev = Q.evaluateQuests();
		expect(ev.done_count).toBe(0);
		expect(ev.quests.every((q) => q.progress === 0)).toBe(true);
	});

	it('every quest links somewhere real and pays XP', () => {
		for (const q of Q.QUESTS) {
			expect(q.cta.href).toMatch(/^\//);
			expect(q.xp).toBeGreaterThan(0);
			expect(q.target).toBeGreaterThan(0);
		}
		expect(Q.DAILY_CLEAR.need).toBeLessThanOrEqual(Q.QUESTS.length);
	});
});

describe('UTC day helpers', () => {
	it('bounds a UTC day', () => {
		expect(Q.dayBounds('2026-09-29')).toEqual({ start: '2026-09-29T00:00:00.000Z', end: '2026-09-30T00:00:00.000Z' });
		expect(Q.utcDay(Date.UTC(2026, 8, 29, 23, 59))).toBe('2026-09-29');
		expect(Q.previousDay('2026-03-01')).toBe('2026-02-28');
	});
});

describe('clearStreak', () => {
	it('counts consecutive clears ending today', () => {
		expect(Q.clearStreak(['2026-09-29', '2026-09-28', '2026-09-27', '2026-09-25'], '2026-09-29')).toEqual({ current: 3, longest: 3 });
	});

	it('stays alive through today when the last clear was yesterday', () => {
		expect(Q.clearStreak(['2026-09-28', '2026-09-27'], '2026-09-29').current).toBe(2);
	});

	it('breaks after a whole missed day but remembers the longest run', () => {
		const days = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-26'];
		expect(Q.clearStreak(days, '2026-09-29')).toEqual({ current: 0, longest: 4 });
	});
});

describe('levelFor', () => {
	it('uses a gently rising curve', () => {
		expect(Q.xpForLevel(1)).toBe(0);
		expect(Q.xpForLevel(2)).toBe(100);
		expect(Q.xpForLevel(3)).toBe(300);
		expect(Q.levelFor(0)).toMatchObject({ level: 1, into_level: 0, level_span: 100, next_level_at: 100 });
		expect(Q.levelFor(99).level).toBe(1);
		expect(Q.levelFor(100).level).toBe(2);
		expect(Q.levelFor(450)).toMatchObject({ level: 3, into_level: 150, level_span: 300 });
	});

	it('never goes negative', () => {
		expect(Q.levelFor(-20)).toMatchObject({ total: 0, level: 1 });
	});
});

describe('questCatalog', () => {
	it('shows the real quests with no progress to a signed-out visitor', () => {
		const c = Q.questCatalog(Date.UTC(2026, 8, 29, 12));
		expect(c.day).toBe('2026-09-29');
		expect(c.resets_at).toBe('2026-09-30T00:00:00.000Z');
		expect(c.quests.every((q) => q.progress === null && q.done === false)).toBe(true);
	});
});

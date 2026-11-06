/**
 * Coin World Tour — pure trending→commentary mapping (src/tour-commentary.js).
 *
 * The guide agent's narration is generated entirely by these pure functions, so
 * pinning them here guarantees the tour speaks correctly at every stop and across
 * every feed shape (empty, one coin, overflow, junk symbols) without spinning up
 * a browser. The render surfaces + the Playwright caster import the same module,
 * so this is the contract for all three.
 */

import { describe, it, expect } from 'vitest';
import {
	TOUR_PREFIX,
	TOUR_WAYPOINTS,
	waypointByName,
	normalizeLaunches,
	tourCommentary,
} from '../src/tour-commentary.js';

const FEED = [
	{ symbol: 'ALPHA', rank: 1, mint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
	{ symbol: '$BETA', rank: 2, mint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
	{ symbol: 'GAMMA', rank: 3, mint: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' },
	{ symbol: 'DELTA', rank: 4, mint: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' },
];

describe('normalizeLaunches', () => {
	it('takes the top-N, defaults to 3', () => {
		const items = normalizeLaunches(FEED);
		expect(items).toHaveLength(3);
		expect(items.map((i) => i.symbol)).toEqual(['$ALPHA', '$BETA', '$GAMMA']);
		expect(items.map((i) => i.rank)).toEqual([1, 2, 3]);
	});

	it('respects an explicit limit', () => {
		expect(normalizeLaunches(FEED, { limit: 1 })).toHaveLength(1);
		expect(normalizeLaunches(FEED, { limit: 10 })).toHaveLength(4);
	});

	it('normalizes symbols to a single leading $ and never carries a mint', () => {
		const [a, b] = normalizeLaunches(FEED, { limit: 2 });
		expect(a.symbol).toBe('$ALPHA'); // bare symbol gains a $
		expect(b.symbol).toBe('$BETA');  // pre-$'d symbol is not doubled
		expect(a).not.toHaveProperty('mint');
	});

	it('truncates a pathologically long symbol', () => {
		const [it0] = normalizeLaunches([{ symbol: 'SUPERCALIFRAGILISTIC', rank: 1 }]);
		expect(it0.symbol.length).toBeLessThanOrEqual(13); // $ + 12 chars incl. ellipsis
		expect(it0.symbol.endsWith('…')).toBe(true);
	});

	it('falls back to feed position when rank is missing/invalid', () => {
		const items = normalizeLaunches([
			{ symbol: 'NORANK' },
			{ symbol: 'BADRANK', rank: -5 },
		]);
		expect(items.map((i) => i.rank)).toEqual([1, 2]);
	});

	it('drops empty/junk entries and tolerates non-arrays', () => {
		expect(normalizeLaunches([{ symbol: '' }, { symbol: '$' }, {}])).toEqual([]);
		expect(normalizeLaunches(null)).toEqual([]);
		expect(normalizeLaunches(undefined)).toEqual([]);
	});
});

describe('tourCommentary', () => {
	it('stamps the badge with the shared prefix + waypoint label', () => {
		const c = tourCommentary('arena', FEED);
		expect(c.badge).toBe(`${TOUR_PREFIX}Into the arena`);
		expect(c.label).toBe('Into the arena');
		expect(c.where).toBe('arena');
		expect(c.name).toBe('arena');
	});

	it('enumerates trending coins factually with rank, for an arena stop', () => {
		const c = tourCommentary('arena', FEED.slice(0, 2));
		expect(c.line).toContain('$ALPHA (#1)');
		expect(c.line).toContain('$BETA (#2)');
		expect(c.line).toContain('launch feed');
		expect(c.items).toHaveLength(2);
	});

	it('uses the walk-in register for a lobby stop', () => {
		const c = tourCommentary('lobby', FEED.slice(0, 1));
		expect(c.where).toBe('lobby');
		expect(c.line).toContain('Trending as we walk in');
		expect(c.line).toContain('$ALPHA (#1)');
	});

	it('never goes silent when the feed is empty', () => {
		const arena = tourCommentary('arena', []);
		const lobby = tourCommentary('lobby', []);
		expect(arena.items).toEqual([]);
		expect(arena.line).toMatch(/arena|feed’s quiet/i);
		expect(lobby.line).toMatch(/launch feed|walk the world/i);
		// A factual, non-promotional fallback — no "buy", no recommendation.
		expect(arena.line.toLowerCase()).not.toContain('buy');
	});

	it('falls back to the first waypoint on an unknown name', () => {
		const c = tourCommentary('does-not-exist', FEED);
		expect(c.name).toBe(TOUR_WAYPOINTS[0].name);
	});

	it('joins multiple coins readably', () => {
		const c = tourCommentary('arena', FEED, { limit: 3 });
		expect(c.line).toContain('$ALPHA (#1), $BETA (#2) and $GAMMA (#3)');
	});
});

describe('waypoint table', () => {
	it('exposes a stable, non-empty loop with lobby first', () => {
		expect(TOUR_WAYPOINTS.length).toBeGreaterThanOrEqual(3);
		expect(TOUR_WAYPOINTS[0].name).toBe('lobby');
		for (const w of TOUR_WAYPOINTS) {
			expect(w.name).toBeTruthy();
			expect(w.label).toBeTruthy();
			expect(['lobby', 'arena']).toContain(w.where);
		}
	});

	it('waypointByName resolves known stops and rejects unknowns', () => {
		expect(waypointByName('arena')?.label).toBe('Into the arena');
		expect(waypointByName('nope')).toBeNull();
	});
});

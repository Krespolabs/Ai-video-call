// Pins the proof-of-grind gallery store's query/leaderboard/filter behavior on
// the in-memory fallback (no Redis in CI). The privacy projection is covered in
// vanity-rarity.test.js; this locks ordering, pagination, filters, and stats.

import { describe, it, expect, beforeEach } from 'vitest';
import {
	putEntry,
	getEntry,
	removeEntry,
	queryEntries,
	topByScore,
	galleryStats,
} from '../api/_lib/vanity-gallery-store.js';

const ADDR = (c) => c.repeat(43).slice(0, 43); // 43-char base58-ish filler
function mk(addr, score, tier, prefix, ts) {
	return {
		address: addr,
		rarityScore: score,
		rarityBits: score / 100,
		tier,
		tierLabel: tier[0].toUpperCase() + tier.slice(1),
		pattern: { prefix, suffix: null, ignoreCase: false },
		expectedAttempts: 2 ** Math.round(score / 100),
		bonuses: [],
		verified: true,
		ts: ts || Date.now(),
	};
}

// Unique addresses per test run so the shared in-memory map doesn't collide.
let n = 0;
const uniq = () => `Z${(n++).toString().padStart(2, '0')}${ADDR('1')}`.slice(0, 43);

describe('gallery store query + leaderboard (in-memory fallback)', () => {
	let mythic, rare, uncommon;
	beforeEach(async () => {
		mythic = uniq();
		rare = uniq();
		uncommon = uniq();
		await putEntry(mk(mythic, 2900, 'mythic', 'Sol', 1000));
		await putEntry(mk(rare, 1172, 'rare', 'So', 2000));
		await putEntry(mk(uncommon, 586, 'uncommon', 'S', 3000));
	});

	it('leaderboard is ordered by rarity score descending', async () => {
		const top = await topByScore(10);
		const idx = top.findIndex((e) => e.address === mythic);
		const idxRare = top.findIndex((e) => e.address === rare);
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(idx).toBeLessThan(idxRare);
	});

	it('sort=score returns rarest first, sort=recency returns newest first', async () => {
		const byScore = await queryEntries({ sort: 'score', limit: 100 });
		const scores = byScore.entries.map((e) => e.rarityScore);
		const sorted = [...scores].sort((a, b) => b - a);
		expect(scores).toEqual(sorted);

		const byRecency = await queryEntries({ sort: 'recency', limit: 100 });
		const tsList = byRecency.entries.map((e) => e.ts);
		const tsSorted = [...tsList].sort((a, b) => b - a);
		expect(tsList).toEqual(tsSorted);
	});

	it('paginates with total + hasMore', async () => {
		const page = await queryEntries({ sort: 'score', limit: 2, offset: 0 });
		expect(page.entries.length).toBe(2);
		expect(page.total).toBeGreaterThanOrEqual(3);
		expect(page.hasMore).toBe(true);
	});

	it('filters by tier', async () => {
		const rareOnly = await queryEntries({ tier: 'rare', limit: 100 });
		expect(rareOnly.entries.every((e) => e.tier === 'rare')).toBe(true);
		expect(rareOnly.entries.some((e) => e.address === rare)).toBe(true);
	});

	it('filters by pattern substring (case-insensitive)', async () => {
		const hits = await queryEntries({ contains: 'sol', limit: 100 });
		expect(hits.entries.some((e) => e.address === mythic)).toBe(true);
	});

	it('stats report totals + per-tier histogram + the rarest entry', async () => {
		const s = await galleryStats();
		expect(s.total).toBeGreaterThanOrEqual(3);
		expect(s.byTier.mythic).toBeGreaterThanOrEqual(1);
		expect(s.rarest.rarityScore).toBeGreaterThanOrEqual(2900);
	});

	it('get + remove are idempotent on address', async () => {
		const a = uniq();
		await putEntry(mk(a, 500, 'uncommon', 'S'));
		expect((await getEntry(a)).rarityScore).toBe(500);
		// Re-publish updates in place (one entry per address).
		await putEntry(mk(a, 999, 'rare', 'So'));
		expect((await getEntry(a)).rarityScore).toBe(999);
		await removeEntry(a);
		expect(await getEntry(a)).toBeNull();
	});
});

// Unit tests for the agent skill-price cache (api/_lib/skill-price-cache.js).
//
// The module's job is a read-through cache over agent_skill_prices: serve from
// the shared cache adapter when warm, fall through to the DB on a miss (then
// store), and drop the entry on invalidation so the next read reflects an edit.
// These tests pin that orchestration by counting DB round-trips.
//
// The cache adapter (_lib/cache.js) is replaced with a deterministic Map-backed
// fake so the test never depends on whether Upstash is configured in the
// environment — cache.js's own Redis/in-memory behaviour is exercised elsewhere.
// db.js is replaced with a counting sql stub so each agent's DB hits are
// observable.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Map-backed cache adapter fake ────────────────────────────────────────────
const store = new Map();
const cacheGet = vi.fn(async (key) => (store.has(key) ? store.get(key) : null));
const cacheSet = vi.fn(async (key, value) => {
	store.set(key, value);
});
const cacheDel = vi.fn(async (key) => {
	store.delete(key);
});
vi.mock('../../api/_lib/cache.js', () => ({ cacheGet, cacheSet, cacheDel }));

// ── Counting SQL stub ────────────────────────────────────────────────────────
// Returns the canned active-price rows for the queried agent id and tallies how
// many times each agent was actually read from the DB.
const dbHits = new Map(); // agentId → count
const pricesByAgent = new Map(); // agentId → rows
const sql = vi.fn(async (_strings, ...values) => {
	const agentId = values[0];
	dbHits.set(agentId, (dbHits.get(agentId) || 0) + 1);
	return pricesByAgent.get(agentId) ?? [];
});
vi.mock('../../api/_lib/db.js', () => ({ sql, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const { getSkillPrices, getSkillPrice, invalidateSkillPriceCache, skillPriceMap } = await import(
	'../../api/_lib/skill-price-cache.js'
);

// $THREE — the only coin this platform references.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const AGENT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const AGENT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

function priceRow(skill, over = {}) {
	return {
		skill,
		amount: 50000,
		currency_mint: THREE_MINT,
		chain: 'solana',
		mint_decimals: 6,
		trial_uses: 0,
		time_pass_hours: null,
		time_pass_amount: null,
		...over,
	};
}

beforeEach(() => {
	store.clear();
	dbHits.clear();
	pricesByAgent.clear();
	cacheGet.mockClear();
	cacheSet.mockClear();
	cacheDel.mockClear();
	sql.mockClear();
});

describe('getSkillPrices — read-through caching', () => {
	it('hits the DB once, then serves repeat reads from cache', async () => {
		pricesByAgent.set(AGENT_A, [priceRow('translate')]);

		const first = await getSkillPrices(AGENT_A);
		expect(first).toEqual([priceRow('translate')]);
		expect(dbHits.get(AGENT_A)).toBe(1);
		expect(cacheSet).toHaveBeenCalledTimes(1);

		const second = await getSkillPrices(AGENT_A);
		expect(second).toEqual([priceRow('translate')]);
		// Still 1 — the second read was served from the cache, no new DB query.
		expect(dbHits.get(AGENT_A)).toBe(1);
	});

	it('caches each agent independently', async () => {
		pricesByAgent.set(AGENT_A, [priceRow('translate')]);
		pricesByAgent.set(AGENT_B, [priceRow('summarize', { amount: 99000 })]);

		await getSkillPrices(AGENT_A);
		await getSkillPrices(AGENT_B);
		const a2 = await getSkillPrices(AGENT_A);
		const b2 = await getSkillPrices(AGENT_B);

		expect(a2[0].skill).toBe('translate');
		expect(b2[0].skill).toBe('summarize');
		expect(dbHits.get(AGENT_A)).toBe(1);
		expect(dbHits.get(AGENT_B)).toBe(1);
	});

	it('falls back to a direct DB read when the cache backend throws', async () => {
		pricesByAgent.set(AGENT_A, [priceRow('translate')]);
		cacheGet.mockRejectedValueOnce(new Error('redis down'));

		const rows = await getSkillPrices(AGENT_A);
		expect(rows).toEqual([priceRow('translate')]);
		expect(dbHits.get(AGENT_A)).toBe(1);
	});
});

describe('invalidateSkillPriceCache', () => {
	it('drops the entry so the next read re-queries the DB', async () => {
		pricesByAgent.set(AGENT_A, [priceRow('translate', { amount: 50000 })]);
		await getSkillPrices(AGENT_A);
		expect(dbHits.get(AGENT_A)).toBe(1);

		// Creator edits the price; the write path invalidates.
		pricesByAgent.set(AGENT_A, [priceRow('translate', { amount: 75000 })]);
		await invalidateSkillPriceCache(AGENT_A);
		expect(cacheDel).toHaveBeenCalledTimes(1);

		const after = await getSkillPrices(AGENT_A);
		expect(after[0].amount).toBe(75000); // fresh value, not the stale 50000
		expect(dbHits.get(AGENT_A)).toBe(2); // re-queried after invalidation
	});
});

describe('getSkillPrice — single skill via the agent cache', () => {
	it('returns the matching row and reuses the warm cache', async () => {
		pricesByAgent.set(AGENT_A, [priceRow('translate'), priceRow('summarize')]);

		await getSkillPrices(AGENT_A); // warm the cache
		const hit = await getSkillPrice(AGENT_A, 'summarize');
		expect(hit).toMatchObject({ skill: 'summarize', currency_mint: THREE_MINT });
		expect(dbHits.get(AGENT_A)).toBe(1); // served from the warm cache
	});

	it('returns null when the skill is not priced', async () => {
		pricesByAgent.set(AGENT_A, [priceRow('translate')]);
		expect(await getSkillPrice(AGENT_A, 'nope')).toBeNull();
	});
});

describe('skillPriceMap', () => {
	it('folds rows into a map keyed by skill with the full pricing shape', async () => {
		const map = skillPriceMap([
			priceRow('translate', { amount: 50000, trial_uses: 2 }),
			priceRow('summarize', { amount: 100000, time_pass_hours: 24, time_pass_amount: 250000 }),
		]);
		expect(Object.keys(map).sort()).toEqual(['summarize', 'translate']);
		expect(map.translate).toEqual({
			amount: 50000,
			currency_mint: THREE_MINT,
			chain: 'solana',
			mint_decimals: 6,
			trial_uses: 2,
			time_pass_hours: null,
			time_pass_amount: null,
			pricing_type: 'fixed',
			minimum_amount: null,
			gate_type: 'price',
			nft_collection_mint: null,
		});
		expect(map.summarize.time_pass_hours).toBe(24);
		expect(map.summarize.time_pass_amount).toBe(250000);
	});

	it('surfaces pwyw pricing_type and minimum_amount (as a string) when present', () => {
		const map = skillPriceMap([
			priceRow('tip', { amount: 100000, pricing_type: 'pwyw', minimum_amount: 50000 }),
			priceRow('plain', { amount: 75000 }),
		]);
		expect(map.tip.pricing_type).toBe('pwyw');
		expect(map.tip.minimum_amount).toBe('50000');
		// Unknown/absent pricing_type folds to the fixed default.
		expect(map.plain.pricing_type).toBe('fixed');
		expect(map.plain.minimum_amount).toBeNull();
	});

	it('surfaces an NFT gate (gate_type + collection); price rows report gate_type "price" with no collection', () => {
		const map = skillPriceMap([
			priceRow('holders_only', { amount: 0, gate_type: 'nft', nft_collection_mint: 'THREEsynthetic1111111111111111111111111111' }),
			priceRow('paid', { amount: 75000 }),
		]);
		expect(map.holders_only.gate_type).toBe('nft');
		expect(map.holders_only.nft_collection_mint).toBe('THREEsynthetic1111111111111111111111111111');
		// A price row never leaks a collection even if a stray value were present.
		expect(map.paid.gate_type).toBe('price');
		expect(map.paid.nft_collection_mint).toBeNull();
	});

	it('defaults mint_decimals to 6 and trial_uses to 0 when a row omits them', () => {
		const map = skillPriceMap([
			{ skill: 'translate', amount: 50000, currency_mint: THREE_MINT, chain: 'solana' },
		]);
		expect(map.translate.mint_decimals).toBe(6);
		expect(map.translate.trial_uses).toBe(0);
		expect(map.translate.time_pass_hours).toBeNull();
	});

	it('returns an empty object for empty or nullish input', () => {
		expect(skillPriceMap([])).toEqual({});
		expect(skillPriceMap(null)).toEqual({});
		expect(skillPriceMap(undefined)).toEqual({});
	});
});

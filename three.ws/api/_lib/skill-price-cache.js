// Cache for agent skill prices — Upstash Redis (shared) with in-memory fallback.
//
// Skill prices are read on every purchase flow, agent embed load, marketplace
// detail fetch, and agent-detail GET. They change only when a creator edits
// them, so caching them takes a DB round-trip off all of those hot read paths.
//
// Backed by the shared cache adapter (_lib/cache.js): Upstash Redis when it is
// configured, an in-memory Map otherwise (dev + tests need no extra config).
// Using the shared adapter — instead of a process-local Map — is what makes
// invalidation correct on Vercel: a price edit handled by one serverless
// instance issues a Redis DEL that every other warm instance observes on its
// next read. A per-instance Map cannot do that; it can only clear the one
// instance that handled the write, leaving every other instance to serve stale
// prices until its own TTL lapses. The adapter's short read-memo additionally
// collapses bursts of identical reads into a single Redis round-trip.
//
// TTL: 1 hour. Writes to agent_skill_prices MUST call
// invalidateSkillPriceCache(agentId) so a change is reflected immediately
// rather than after the TTL. A brief stale window can never overcharge a buyer:
// the purchase flow snapshots the quoted price onto the skill_purchases row at
// create time and confirms against that snapshot, not the live price.

import { sql } from './db.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';

const TTL_SECONDS = 60 * 60; // 1 hour
const KEY_PREFIX = 'skill-prices:v1:';

function keyFor(agentId) {
	return `${KEY_PREFIX}${agentId}`;
}

async function loadFromDb(agentId) {
	return sql`
		SELECT skill, amount, currency_mint, chain, mint_decimals,
		       trial_uses, time_pass_hours, time_pass_amount,
		       pricing_type, minimum_amount,
		       gate_type, nft_collection_mint
		FROM agent_skill_prices
		WHERE agent_id = ${agentId} AND is_active = true
	`;
}

/**
 * Active skill prices for an agent, served from the cache when warm and read
 * through to the database (then cached for 1 hour) on a miss. A cache backend
 * failure degrades to a direct DB read — it never fails the caller.
 * @param {string} agentId
 * @returns {Promise<Array<{ skill, amount, currency_mint, chain, mint_decimals,
 *                           trial_uses, time_pass_hours, time_pass_amount }>>}
 */
export async function getSkillPrices(agentId) {
	const key = keyFor(agentId);
	const cached = await cacheGet(key).catch(() => null);
	if (Array.isArray(cached)) return cached;

	const rows = await loadFromDb(agentId);
	// Write-through is best-effort: a cache hiccup must not fail the read.
	await cacheSet(key, rows, TTL_SECONDS).catch(() => {});
	return rows;
}

/**
 * Invalidate the cached prices for an agent. Call after any write to
 * agent_skill_prices for this agent. Async because the backing DEL may hit
 * Redis — await it so the response is returned only once the entry is cleared
 * (and, with Redis, cleared for every instance).
 * @param {string} agentId
 * @returns {Promise<void>}
 */
export async function invalidateSkillPriceCache(agentId) {
	await cacheDel(keyFor(agentId)).catch(() => {});
}

/**
 * Fetch ONE active price row for (agentId, skill). Uses the agent's full price
 * cache so a warm agent hit costs no extra DB round-trip.
 * @param {string} agentId
 * @param {string} skill
 * @returns {Promise<object|null>}
 */
export async function getSkillPrice(agentId, skill) {
	const rows = await getSkillPrices(agentId);
	return rows.find((r) => r.skill === skill) ?? null;
}

/**
 * Fold active price rows into the `skill_prices` map that agent-detail,
 * marketplace-detail, and skill-access surfaces return: keyed by skill name,
 * each value carrying the atomic amount, currency, chain, and the dimensions the
 * purchase UI needs. Missing optional columns default deterministically so the
 * shape is identical whether a row carries them or not.
 * @param {Array<object>} rows
 * @returns {Record<string, { amount, currency_mint, chain, mint_decimals,
 *                            trial_uses, time_pass_hours, time_pass_amount }>}
 */
export function skillPriceMap(rows) {
	const map = {};
	for (const p of rows || []) {
		map[p.skill] = {
			amount: p.amount,
			currency_mint: p.currency_mint,
			chain: p.chain,
			mint_decimals: p.mint_decimals ?? 6,
			trial_uses: p.trial_uses ?? 0,
			time_pass_hours: p.time_pass_hours ?? null,
			time_pass_amount: p.time_pass_amount ?? null,
			pricing_type: p.pricing_type === 'pwyw' ? 'pwyw' : 'fixed',
			minimum_amount: p.minimum_amount == null ? null : String(p.minimum_amount),
			gate_type: p.gate_type === 'nft' ? 'nft' : 'price',
			nft_collection_mint: p.gate_type === 'nft' ? p.nft_collection_mint ?? null : null,
		};
	}
	return map;
}

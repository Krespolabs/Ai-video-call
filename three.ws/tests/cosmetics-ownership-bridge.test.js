// R22 → R23 ownership bridge: a cosmetic bought over the x402 rail (recorded in
// the Redis ownership ledger) must fold into a player's profile so the worn-rig
// equip authority lets them wear it — in every world, across logins.
//
// Covers the pure server-side seam:
//   • mergeOwnedFromLedger: grants only ids that are premium in THIS worn catalog,
//     ignores free/unknown/foreign-catalog ids, is idempotent, returns the count
//   • equipCosmetic after a merge: a previously-unowned premium id becomes wearable
//   • the ledger reader degrades to [] when Redis isn't configured (fail-open read)
//
// The Redis round-trip itself is exercised against the real Upstash rail on
// deploy; here the reader runs unconfigured so the seam is deterministic.

import { describe, it, expect } from 'vitest';

import {
	newProfile, mergeOwnedFromLedger, equipCosmetic, ownedCosmeticSet,
} from '../multiplayer/src/economy.js';
import { COSMETICS } from '../multiplayer/src/cosmetics-catalog.js';
import { readOwnedCosmetics, normalizeAccountId } from '../multiplayer/src/cosmetics-ownership.js';

// A premium worn cosmetic that exists in BOTH the shop and the rig catalog — the
// real overlap a purchase unlocks. (Picked from the catalog so the test tracks it.)
const PREMIUM = COSMETICS.find((c) => c.tier === 'premium');
const FREE = COSMETICS.find((c) => c.tier === 'free' && c.visual); // a free wearable

describe('mergeOwnedFromLedger — R22 ledger → profile unlock', () => {
	it('grants a premium id from the ledger and makes it wearable', () => {
		const p = newProfile('acct-1');
		expect(ownedCosmeticSet(p).has(PREMIUM.id)).toBe(false);
		expect(equipCosmetic(p, PREMIUM.id)).toBeNull(); // unowned → rejected

		const granted = mergeOwnedFromLedger(p, [PREMIUM.id]);
		expect(granted).toBe(1);
		expect(ownedCosmeticSet(p).has(PREMIUM.id)).toBe(true);
		const equipped = equipCosmetic(p, PREMIUM.id);
		expect(equipped).not.toBeNull();
		expect(equipped[PREMIUM.slot]).toBe(PREMIUM.id);
	});

	it('is idempotent — a second merge of the same id grants nothing new', () => {
		const p = newProfile('acct-2');
		expect(mergeOwnedFromLedger(p, [PREMIUM.id])).toBe(1);
		expect(mergeOwnedFromLedger(p, [PREMIUM.id])).toBe(0);
		expect(p.cosmetics.owned.filter((id) => id === PREMIUM.id)).toHaveLength(1);
	});

	it('ignores free, unknown, and foreign-catalog ledger ids (no error, no grant)', () => {
		const p = newProfile('acct-3');
		// `skin-crimson` is a real shop SKU in the sibling catalog but not a worn-rig
		// cosmetic here — it must be silently ignored, never stored or errored.
		const granted = mergeOwnedFromLedger(p, [FREE.id, 'skin-crimson', 'totally-made-up', PREMIUM.id]);
		expect(granted).toBe(1); // only PREMIUM.id is a premium worn cosmetic
		expect(p.cosmetics.owned).toEqual([PREMIUM.id]);
		expect(equipCosmetic(p, 'skin-crimson')).toBeNull();
	});

	it('handles empty / non-array input without throwing', () => {
		const p = newProfile('acct-4');
		expect(mergeOwnedFromLedger(p, [])).toBe(0);
		expect(mergeOwnedFromLedger(p, null)).toBe(0);
		expect(mergeOwnedFromLedger(p, undefined)).toBe(0);
		expect(p.cosmetics.owned).toEqual([]);
	});
});

describe('cosmetics-ownership reader — fail-open when unconfigured', () => {
	it('normalizeAccountId accepts wallets/guest ids, rejects junk', () => {
		expect(normalizeAccountId('  WwW9dwK7iY5cT9aZ8h6n3v2Q1rT4uYpL5mN6oP7qR8s  '))
			.toBe('WwW9dwK7iY5cT9aZ8h6n3v2Q1rT4uYpL5mN6oP7qR8s');
		expect(normalizeAccountId('guest-abc123')).toBe('guest-abc123');
		expect(normalizeAccountId('a')).toBe('');          // too short
		expect(normalizeAccountId('bad id!')).toBe('');     // illegal chars
		expect(normalizeAccountId(null)).toBe('');
	});

	it('reads [] for any account when Redis is not configured', async () => {
		// No UPSTASH_REDIS_REST_URL/_TOKEN in the test env → fail-open empty read.
		await expect(readOwnedCosmetics('WwW9dwK7iY5cT9aZ8h6n3v2Q1rT4uYpL5mN6oP7qR8s')).resolves.toEqual([]);
		await expect(readOwnedCosmetics('')).resolves.toEqual([]);
	});
});

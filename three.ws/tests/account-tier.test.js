// Unit tests for account tiers ("modes") — api/_lib/account-tier.js.
//
// resolveAccountTier is pure (takes a precomputed holder read), so it tests
// without any RPC. detectHolder's on-chain read is mocked at the three-tier
// boundary to prove fail-closed dedupe + best-of behaviour.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const holderUsd = vi.fn();
vi.mock('../api/_lib/three-tier.js', () => ({ holderUsd: (...a) => holderUsd(...a) }));

import {
	ACCOUNT_TIERS,
	GRANTABLE_TIER_IDS,
	DEFAULT_TIER_ID,
	tierById,
	isGrantableTier,
	normalizeTierGrant,
	detectHolder,
	resolveAccountTier,
} from '../api/_lib/account-tier.js';

const NO_HOLDER = { isHolder: false, amount: 0, usd: 0 };

beforeEach(() => {
	vi.clearAllMocks();
});

describe('tier ladder', () => {
	it('is ordered low→high by rank and starts at the default user tier', () => {
		expect(ACCOUNT_TIERS[0].id).toBe(DEFAULT_TIER_ID);
		expect(ACCOUNT_TIERS[0].rank).toBe(0);
		for (let i = 1; i < ACCOUNT_TIERS.length; i++) {
			expect(ACCOUNT_TIERS[i].rank).toBeGreaterThan(ACCOUNT_TIERS[i - 1].rank);
		}
	});

	it('every tier carries the fields the UI renders', () => {
		for (const t of ACCOUNT_TIERS) {
			expect(typeof t.label).toBe('string');
			expect(t.color).toMatch(/^#[0-9a-f]{6}$/i);
			expect(typeof t.description).toBe('string');
			expect(Array.isArray(t.perks)).toBe(true);
			expect(t.perks.length).toBeGreaterThan(0);
		}
	});

	it('exposes exactly the admin-grantable modes (derived ones excluded)', () => {
		expect(GRANTABLE_TIER_IDS).toEqual(['beta', 'pro', 'three-dimensional']);
		expect(GRANTABLE_TIER_IDS).not.toContain('holder');
		expect(GRANTABLE_TIER_IDS).not.toContain('user');
	});
});

describe('helpers', () => {
	it('tierById resolves known ids and rejects unknown', () => {
		expect(tierById('holder').label).toBe('Holder');
		expect(tierById('nope')).toBeNull();
	});

	it('isGrantableTier gates the admin grant set', () => {
		expect(isGrantableTier('beta')).toBe(true);
		expect(isGrantableTier('three-dimensional')).toBe(true);
		expect(isGrantableTier('holder')).toBe(false);
		expect(isGrantableTier('user')).toBe(false);
	});

	it('normalizeTierGrant canonicalizes, clears, and rejects', () => {
		expect(normalizeTierGrant(' BETA ')).toBe('beta');
		expect(normalizeTierGrant('three-dimensional')).toBe('three-dimensional');
		expect(normalizeTierGrant('none')).toBeNull();
		expect(normalizeTierGrant('user')).toBeNull();
		expect(normalizeTierGrant('')).toBeNull();
		expect(normalizeTierGrant(null)).toBeNull();
		expect(normalizeTierGrant('holder')).toBeNull(); // derived, not grantable
		expect(normalizeTierGrant('bogus')).toBeNull();
	});
});

describe('resolveAccountTier', () => {
	it('defaults a plain account to the user tier with beta next', () => {
		const r = resolveAccountTier({ plan: 'free', account_tier: null }, { holder: NO_HOLDER });
		expect(r.primary.id).toBe('user');
		expect(r.badges.map((b) => b.id)).toEqual(['user']);
		expect(r.next.id).toBe('beta');
		expect(r.granted).toBeNull();
	});

	it('applies a granted beta mode', () => {
		const r = resolveAccountTier({ plan: 'free', account_tier: 'beta' }, { holder: NO_HOLDER });
		expect(r.granted).toBe('beta');
		expect(r.primary.id).toBe('beta');
		expect(r.badges.map((b) => b.id)).toEqual(['user', 'beta']);
		expect(r.next.id).toBe('pro');
	});

	it('derives the pro badge from a paid plan without a grant', () => {
		for (const plan of ['pro', 'team', 'enterprise']) {
			const r = resolveAccountTier({ plan, account_tier: null }, { holder: NO_HOLDER });
			expect(r.badges.some((b) => b.id === 'pro')).toBe(true);
			expect(r.primary.id).toBe('pro');
		}
	});

	it('awards the holder badge from an on-chain read and ranks it above pro', () => {
		const r = resolveAccountTier(
			{ plan: 'pro', account_tier: null },
			{ holder: { isHolder: true, amount: 1000, usd: 42 } },
		);
		const ids = r.badges.map((b) => b.id);
		expect(ids).toContain('holder');
		expect(ids).toContain('pro');
		expect(r.primary.id).toBe('holder');
		expect(r.next.id).toBe('three-dimensional');
	});

	it('lets three-dimensional sit at the top with nothing next', () => {
		const r = resolveAccountTier(
			{ plan: 'free', account_tier: 'three-dimensional' },
			{ holder: NO_HOLDER },
		);
		expect(r.primary.id).toBe('three-dimensional');
		expect(r.next).toBeNull();
	});

	it('ignores a non-grantable stored value (e.g. a stale holder grant)', () => {
		const r = resolveAccountTier({ plan: 'free', account_tier: 'holder' }, { holder: NO_HOLDER });
		expect(r.granted).toBeNull();
		expect(r.badges.map((b) => b.id)).toEqual(['user']);
	});

	it('stacks every active badge in rank order', () => {
		const r = resolveAccountTier(
			{ plan: 'team', account_tier: 'beta' },
			{ holder: { isHolder: true, amount: 5, usd: 9 } },
		);
		expect(r.badges.map((b) => b.id)).toEqual(['user', 'beta', 'pro', 'holder']);
		expect(r.primary.id).toBe('holder');
	});

	it('degrades to user when called with no holder read', () => {
		const r = resolveAccountTier({ plan: 'free', account_tier: null });
		expect(r.primary.id).toBe('user');
		expect(r.holder.isHolder).toBe(false);
	});
});

describe('detectHolder', () => {
	it('returns not-a-holder for no wallets without any RPC call', async () => {
		const r = await detectHolder([]);
		expect(r).toEqual({ isHolder: false, amount: 0, usd: 0 });
		expect(holderUsd).not.toHaveBeenCalled();
	});

	it('flags a holder from a single funded wallet', async () => {
		holderUsd.mockResolvedValueOnce({ amount: 1234, usd: 56.7, priceUsd: 0.046 });
		const r = await detectHolder(['Wallet1']);
		expect(r.isHolder).toBe(true);
		expect(r.amount).toBe(1234);
		expect(r.usd).toBeCloseTo(56.7);
	});

	it('dedupes repeated addresses', async () => {
		holderUsd.mockResolvedValue({ amount: 10, usd: 1, priceUsd: 0.1 });
		await detectHolder(['W', 'W', 'W']);
		expect(holderUsd).toHaveBeenCalledTimes(1);
	});

	it('keeps the best holding across multiple wallets', async () => {
		holderUsd
			.mockResolvedValueOnce({ amount: 5, usd: 1, priceUsd: 0.2 })
			.mockResolvedValueOnce({ amount: 500, usd: 100, priceUsd: 0.2 });
		const r = await detectHolder(['A', 'B']);
		expect(r.amount).toBe(500);
		expect(r.usd).toBe(100);
		expect(r.isHolder).toBe(true);
	});

	it('fails closed — a zero read is not a holder', async () => {
		holderUsd.mockResolvedValue({ amount: 0, usd: 0, priceUsd: 0 });
		const r = await detectHolder(['A', 'B']);
		expect(r.isHolder).toBe(false);
	});
});

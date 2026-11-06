// Unit tests for the $THREE holder-tier lever (api/_lib/three-tier.js).
// Balance/price reads are mocked: these prove the tier ladder, the discount curve,
// graceful degradation to Member, and the signed tier-pass round-trip.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBalances = vi.fn();
const getTokenPriceUsd = vi.fn();
vi.mock('../api/_lib/balances.js', () => ({ getBalances: (...a) => getBalances(...a) }));
vi.mock('../api/_lib/token/price.js', () => ({ getTokenPriceUsd: (...a) => getTokenPriceUsd(...a) }));

import {
	TIERS,
	tierForUsd,
	nextTier,
	holderUsd,
	resolveUserTier,
	holderDiscountBps,
	signTierPass,
	verifyTierPass,
} from '../api/_lib/three-tier.js';
import { TOKEN_MINT } from '../api/_lib/token/config.js';

const WALLET = 'So11111111111111111111111111111111111111112';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('tier ladder', () => {
	it('ladder is ordered and starts at a free Member tier', () => {
		expect(TIERS[0].id).toBe('member');
		expect(TIERS[0].minUsd).toBe(0);
		expect(TIERS[0].discountBps).toBe(0);
		for (let i = 1; i < TIERS.length; i++) {
			expect(TIERS[i].minUsd).toBeGreaterThan(TIERS[i - 1].minUsd);
			expect(TIERS[i].discountBps).toBeGreaterThanOrEqual(TIERS[i - 1].discountBps);
		}
	});

	it('tierForUsd resolves the highest tier at or below the held value', () => {
		expect(tierForUsd(0).id).toBe('member');
		expect(tierForUsd(24).id).toBe('member');
		expect(tierForUsd(25).id).toBe('bronze');
		expect(tierForUsd(150).id).toBe('silver');
		expect(tierForUsd(999).id).toBe('gold');
		expect(tierForUsd(100000).id).toBe('genesis');
	});

	it('nextTier points up the ladder and is null at the top', () => {
		expect(nextTier(TIERS[0]).id).toBe('bronze');
		expect(nextTier(TIERS[TIERS.length - 1])).toBeNull();
	});
});

describe('holderUsd', () => {
	it('returns 0 for a non-Solana address without any RPC call', async () => {
		const r = await holderUsd('not-a-wallet');
		expect(r.usd).toBe(0);
		expect(getBalances).not.toHaveBeenCalled();
	});

	it('uses the balance entry usd when present', async () => {
		getBalances.mockResolvedValue({ tokens: [{ mint: TOKEN_MINT, amount: 1000, usd: 120, price: 0.12 }] });
		const r = await holderUsd(WALLET);
		expect(r.usd).toBe(120);
		expect(r.amount).toBe(1000);
	});

	it('falls back to the $THREE price feed when the entry has no usd', async () => {
		getBalances.mockResolvedValue({ tokens: [{ mint: TOKEN_MINT, amount: 1000 }] });
		getTokenPriceUsd.mockResolvedValue({ priceUsd: 0.2 });
		const r = await holderUsd(WALLET);
		expect(r.usd).toBeCloseTo(200);
	});

	it('degrades to 0 on a balance read failure (never throws)', async () => {
		getBalances.mockRejectedValue(new Error('rpc down'));
		const r = await holderUsd(WALLET);
		expect(r.usd).toBe(0);
	});
});

describe('resolveUserTier + holderDiscountBps', () => {
	it('maps held value to the right tier and discount', async () => {
		getBalances.mockResolvedValue({ tokens: [{ mint: TOKEN_MINT, amount: 5000, usd: 600, price: 0.12 }] });
		const { tier, usd } = await resolveUserTier({ wallet_address: WALLET });
		expect(tier.id).toBe('gold');
		expect(usd).toBe(600);
		expect(await holderDiscountBps({ wallet_address: WALLET })).toBe(2000);
	});

	it('a wallet-less user is Member with no discount', async () => {
		const { tier } = await resolveUserTier({});
		expect(tier.id).toBe('member');
		expect(await holderDiscountBps({})).toBe(0);
		expect(getBalances).not.toHaveBeenCalled();
	});
});

describe('signed tier pass', () => {
	it('round-trips a valid pass', () => {
		const pass = signTierPass({ wallet: WALLET, level: 3, tierId: 'gold', usd: 600 });
		const payload = verifyTierPass(pass);
		expect(payload).toBeTruthy();
		expect(payload.level).toBe(3);
		expect(payload.tierId).toBe('gold');
		expect(payload.kind).toBe('three-tier');
	});

	it('rejects a tampered pass', () => {
		const pass = signTierPass({ wallet: WALLET, level: 4, tierId: 'genesis', usd: 3000 });
		const [body, sig] = pass.split('.');
		expect(verifyTierPass(`${body}.${sig.slice(0, -2)}ZZ`)).toBeNull();
	});

	it('rejects a malformed token', () => {
		expect(verifyTierPass('garbage')).toBeNull();
		expect(verifyTierPass('')).toBeNull();
	});
});

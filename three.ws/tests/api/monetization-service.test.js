// Unit tests for MonetizationService — the single seam the monetization API
// handlers call through. The lower-level primitives it orchestrates (payout
// resolution, on-chain confirmation, access checks, fee math, balance
// accounting) have their own suites, so here they are mocked: these tests pin
// the service's own business rules — ownership gating, the atomic price replace,
// the already-owned / idempotent purchase paths, error → status mapping, and the
// creator-sales rollup.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Content-addressed SQL mock ───────────────────────────────────────────────
// Classify each tagged-template query by its text and answer from `state`, so
// neither call order nor the lazy `sql`null`` time-window fragment can desync a
// queue. Every call is recorded for write-path assertions.
const state = {
	agent: null, // agent_identities ownership lookup → { id, user_id } | null
	price: null, // single-skill agent_skill_prices lookup → row | null
	prices: [], // active price list
	existing: null, // active-access (confirmed/trial) row | null
	pending: null, // reusable pending row | null
	inserted: null, // INSERT ... RETURNING row
	confirmRow: null, // confirm lookup row | null
	royalty: [], // royalty_ledger rows
	assets: [], // asset_purchases rows
	assetsThrow: false, // simulate the asset_purchases table not existing yet
};
let calls = [];

function respond(q) {
	if (/FROM skill_purchases sp/i.test(q) && /LEFT JOIN agent_skill_prices/i.test(q))
		return state.confirmRow ? [state.confirmRow] : [];
	if (/SELECT id, user_id\s+FROM agent_identities/i.test(q)) return state.agent ? [state.agent] : [];
	if (/FROM agent_skill_prices/i.test(q) && /AND skill =/i.test(q)) return state.price ? [state.price] : [];
	if (/SELECT skill, amount/i.test(q) && /FROM agent_skill_prices/i.test(q)) return state.prices;
	if (/FROM skill_purchases/i.test(q) && /status IN \('confirmed', 'trial'\)/i.test(q))
		return state.existing ? [state.existing] : [];
	if (/FROM skill_purchases/i.test(q) && /status = 'pending'/i.test(q))
		return state.pending ? [state.pending] : [];
	if (/INSERT INTO skill_purchases/i.test(q)) return state.inserted ? [state.inserted] : [];
	if (/FROM royalty_ledger/i.test(q)) return state.royalty;
	if (/FROM asset_purchases/i.test(q)) return state.assets;
	return [];
}

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
	calls.push({ q, values });
	if (state.assetsThrow && /FROM asset_purchases/i.test(q)) {
		return Promise.reject(Object.assign(new Error('relation "asset_purchases" does not exist'), { code: '42P01' }));
	}
	return Promise.resolve(respond(q));
});
sqlMock.transaction = vi.fn((queries) => Promise.all(queries));

// Mock db.js so importing the service never reaches Neon/env config — the
// service's own queries run through the injected sqlMock instead.
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// ── Mock the lower-level helpers the service orchestrates ─────────────────────
const purchaseConfirm = {
	confirmSkillPurchase: vi.fn(async () => ({ status: 'confirmed', tx_signature: 'SIG' })),
	resolvePayoutAddress: vi.fn(async () => 'PAYOUT'),
	logEvent: vi.fn(async () => {}),
};
vi.mock('../../api/_lib/purchase-confirm.js', () => purchaseConfirm);

const skillAccess = { hasSkillAccess: vi.fn(async () => ({ paid: true, owned: true, price: { skill: 'echo' } })) };
vi.mock('../../api/_lib/skill-access.js', () => skillAccess);

const monetization = { getAvailableBalance: vi.fn(async () => ({ earned: 100, withdrawn: 0, pending: 0, available: 100 })) };
vi.mock('../../api/_lib/monetization.js', () => monetization);

const platformFee = {
	resolveMarketplaceFee: vi.fn(async () => ({ bps: 250, feeAtomics: 25000n, recipient: { toBase58: () => 'TREASURY' } })),
};
vi.mock('../../api/_lib/marketplace-platform-fee.js', () => platformFee);

const priceCache = { invalidateSkillPriceCache: vi.fn(() => {}) };
vi.mock('../../api/_lib/skill-price-cache.js', () => priceCache);

const { MonetizationService } = await import('../../api/_lib/services/MonetizationService.js');

// Build a service whose own queries hit the mock; helpers are module-mocked.
const svc = (user) => new MonetizationService(user, { sql: sqlMock });

beforeEach(() => {
	calls = [];
	Object.assign(state, {
		agent: null, price: null, prices: [], existing: null,
		pending: null, inserted: null, confirmRow: null, royalty: [], assets: [], assetsThrow: false,
	});
	vi.clearAllMocks();
});

const findCall = (re) => calls.find((c) => re.test(c.q));

// ── Constructor / auth ────────────────────────────────────────────────────────
describe('constructor + requireAuth', () => {
	it('derives userId from a session user, an auth object, or a raw string', () => {
		expect(svc({ id: 'u1' }).userId).toBe('u1');
		expect(svc({ userId: 'u2' }).userId).toBe('u2');
		expect(svc('u3').userId).toBe('u3');
		expect(svc(null).userId).toBeNull();
	});

	it('requireAuth throws 401 when anonymous', () => {
		expect(() => svc(null).requireAuth()).toThrowError(/sign in required/);
		try { svc(null).requireAuth(); } catch (e) { expect(e.status).toBe(401); expect(e.code).toBe('unauthorized'); }
	});
});

// ── assertOwnership ────────────────────────────────────────────────────────────
describe('assertOwnership', () => {
	it('returns the agent when the caller owns it', async () => {
		state.agent = { id: 'a1', user_id: 'u1' };
		await expect(svc({ id: 'u1' }).assertOwnership('a1')).resolves.toEqual({ id: 'a1', user_id: 'u1' });
	});

	it('throws 404 when the agent does not exist', async () => {
		state.agent = null;
		await expect(svc({ id: 'u1' }).assertOwnership('a1')).rejects.toMatchObject({ status: 404, code: 'not_found' });
	});

	it('throws 403 when the caller is not the owner', async () => {
		state.agent = { id: 'a1', user_id: 'someone-else' };
		await expect(svc({ id: 'u1' }).assertOwnership('a1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
	});

	it('throws 401 when anonymous (before any DB lookup)', async () => {
		await expect(svc(null).assertOwnership('a1')).rejects.toMatchObject({ status: 401 });
		expect(findCall(/FROM agent_identities/i)).toBeUndefined();
	});
});

// ── getSkillPricesForAgent ─────────────────────────────────────────────────────
describe('getSkillPricesForAgent', () => {
	it('returns the active price rows (pure read, no ownership)', async () => {
		state.prices = [{ skill: 'echo', amount: 50000, currency_mint: 'M', chain: 'solana' }];
		const out = await svc(null).getSkillPricesForAgent('a1');
		expect(out).toHaveLength(1);
		expect(out[0].skill).toBe('echo');
		expect(findCall(/FROM agent_identities/i)).toBeUndefined();
	});
});

// ── setSkillPrices ─────────────────────────────────────────────────────────────
describe('setSkillPrices', () => {
	const prices = [
		{ skill: 'web-search', amount: 50000, currency_mint: 'M', chain: 'solana' },
		{ skill: 'summarize', amount: 100000, currency_mint: 'M', chain: 'solana' },
	];

	it('verifies ownership, then atomically deactivates + upserts and invalidates cache', async () => {
		state.agent = { id: 'a1', user_id: 'u1' };
		const out = await svc({ id: 'u1' }).setSkillPrices('a1', prices);
		expect(out).toEqual({ ok: true, count: 2 });
		expect(findCall(/FROM agent_identities/i)).toBeDefined(); // ownership checked
		expect(findCall(/SET is_active = false WHERE agent_id/i)).toBeDefined();
		const inserts = calls.filter((c) => /INTO agent_skill_prices/i.test(c.q));
		expect(inserts).toHaveLength(2);
		expect(inserts.map((c) => c.values[1])).toEqual(['web-search', 'summarize']);
		expect(sqlMock.transaction).toHaveBeenCalledOnce();
		expect(priceCache.invalidateSkillPriceCache).toHaveBeenCalledWith('a1');
	});

	it('skips the redundant ownership lookup when the caller already verified it', async () => {
		await svc({ id: 'u1' }).setSkillPrices('a1', prices, { skipOwnershipCheck: true });
		expect(findCall(/FROM agent_identities/i)).toBeUndefined();
		expect(sqlMock.transaction).toHaveBeenCalledOnce();
	});

	it('rejects a non-owner before any write', async () => {
		state.agent = { id: 'a1', user_id: 'other' };
		await expect(svc({ id: 'u1' }).setSkillPrices('a1', prices)).rejects.toMatchObject({ status: 403 });
		expect(sqlMock.transaction).not.toHaveBeenCalled();
		expect(priceCache.invalidateSkillPriceCache).not.toHaveBeenCalled();
	});
});

// ── preparePurchaseTransaction ─────────────────────────────────────────────────
describe('preparePurchaseTransaction', () => {
	it('throws 401 when anonymous', async () => {
		await expect(svc(null).preparePurchaseTransaction('a1', 'echo')).rejects.toMatchObject({ status: 401 });
	});

	it('throws 404 when the skill is not for sale', async () => {
		state.price = null;
		await expect(svc({ id: 'u1' }).preparePurchaseTransaction('a1', 'echo')).rejects.toMatchObject({
			status: 404, code: 'not_found',
		});
	});

	it('throws 412 when the creator has no payout wallet', async () => {
		state.price = { amount: 1000000, currency_mint: 'M', chain: 'solana', mint_decimals: 6 };
		purchaseConfirm.resolvePayoutAddress.mockResolvedValueOnce(null);
		await expect(svc({ id: 'u1' }).preparePurchaseTransaction('a1', 'echo')).rejects.toMatchObject({
			status: 412, code: 'creator_wallet_missing',
		});
	});

	it('short-circuits when the buyer already has active access', async () => {
		state.price = { amount: 1000000, currency_mint: 'M', chain: 'solana', mint_decimals: 6 };
		state.existing = { reference: 'OLD', status: 'confirmed', tx_signature: 'T', confirmed_at: 'now', valid_until: null, trial_remaining: null, kind: 'purchase' };
		const out = await svc({ id: 'u1' }).preparePurchaseTransaction('a1', 'echo');
		expect(out.already_owned).toBe(true);
		expect(out.reference).toBe('OLD');
		expect(findCall(/INSERT INTO skill_purchases/i)).toBeUndefined();
	});

	it('creates a pending purchase and returns the fee-split quote', async () => {
		state.price = { amount: 1000000, currency_mint: 'MINT', chain: 'solana', mint_decimals: 6 };
		state.inserted = {
			reference: 'REF', amount: '1000000', currency_mint: 'MINT', chain: 'solana',
			expires_at: 'soon', valid_until: null, platform_fee_amount: '25000', platform_fee_wallet: 'TREASURY',
		};
		const out = await svc({ id: 'u1' }).preparePurchaseTransaction('a1', 'echo', { referrerUserId: 'ref-1' });
		expect(out.already_owned).toBe(false);
		expect(out.reference).toBe('REF');
		expect(out.recipient).toBe('PAYOUT');
		expect(out.amount).toBe('1000000');
		expect(out.creator_amount).toBe('975000'); // 1_000_000 − 25_000 fee
		expect(out.fee).toEqual({ recipient: 'TREASURY', amount: '25000', bps: 250 });
		expect(out.kind).toBe('purchase');
		expect(purchaseConfirm.logEvent).toHaveBeenCalledWith('REF', 'created', expect.objectContaining({ skill: 'echo' }));
	});
});

// ── confirmPurchase ────────────────────────────────────────────────────────────
describe('confirmPurchase', () => {
	it('throws 404 when no purchase matches the reference for this user', async () => {
		state.confirmRow = null;
		await expect(svc({ id: 'u1' }).confirmPurchase('REF')).rejects.toMatchObject({ status: 404 });
	});

	it('returns confirmed immediately for an already-confirmed row', async () => {
		state.confirmRow = { id: 'p1', status: 'confirmed', tx_signature: 'DONE', chain: 'solana' };
		const out = await svc({ id: 'u1' }).confirmPurchase('REF');
		expect(out).toEqual({ status: 'confirmed', tx_signature: 'DONE' });
		expect(purchaseConfirm.confirmSkillPurchase).not.toHaveBeenCalled();
	});

	it('throws 410 for an expired pending row', async () => {
		state.confirmRow = { id: 'p1', status: 'pending', chain: 'solana', expires_at: '2000-01-01T00:00:00Z' };
		await expect(svc({ id: 'u1' }).confirmPurchase('REF')).rejects.toMatchObject({ status: 410, code: 'purchase_expired' });
	});

	it('throws 400 when an EVM confirm omits the tx hash', async () => {
		state.confirmRow = { id: 'p1', status: 'pending', chain: 'base', expires_at: null };
		await expect(svc({ id: 'u1' }).confirmPurchase('REF')).rejects.toMatchObject({ status: 400, code: 'tx_hash_required' });
	});

	it('delegates to confirmSkillPurchase for a valid solana pending row', async () => {
		state.confirmRow = { id: 'p1', status: 'pending', chain: 'solana', expires_at: null, amount: '1000000' };
		purchaseConfirm.confirmSkillPurchase.mockResolvedValueOnce({ status: 'confirmed', tx_signature: 'SIG2' });
		const out = await svc({ id: 'u1' }).confirmPurchase('REF');
		expect(out).toEqual({ status: 'confirmed', tx_signature: 'SIG2' });
		expect(purchaseConfirm.confirmSkillPurchase).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'p1', reference: 'REF' }),
			{ txHash: null },
		);
	});
});

// ── checkSkillOwnership ────────────────────────────────────────────────────────
describe('checkSkillOwnership', () => {
	it('maps the canonical access check to has_access (owned → true)', async () => {
		skillAccess.hasSkillAccess.mockResolvedValueOnce({ paid: true, owned: true, price: { skill: 'echo' } });
		const out = await svc({ id: 'u1' }).checkSkillOwnership('a1', 'echo');
		expect(out.has_access).toBe(true);
		expect(out.paid).toBe(true);
		expect(skillAccess.hasSkillAccess).toHaveBeenCalledWith('u1', 'a1', 'echo');
	});

	it('reports has_access false when the buyer does not own a paid skill', async () => {
		skillAccess.hasSkillAccess.mockResolvedValueOnce({ paid: true, owned: false, reason: 'not_purchased' });
		const out = await svc({ id: 'u1' }).checkSkillOwnership('a1', 'echo');
		expect(out.has_access).toBe(false);
		expect(out.reason).toBe('not_purchased');
	});
});

// ── getCreatorSalesData ────────────────────────────────────────────────────────
describe('getCreatorSalesData', () => {
	it('throws 401 when anonymous', async () => {
		await expect(svc(null).getCreatorSalesData()).rejects.toMatchObject({ status: 401 });
	});

	it('rolls up skill royalties + asset sales into totals and a merged feed', async () => {
		state.royalty = [
			{ id: 'r1', price_usd: '2.50', status: 'settled', created_at: '2026-01-02T00:00:00Z', skill_name: 'echo', agent_name: 'A' },
			{ id: 'r2', price_usd: '1.00', status: 'pending', created_at: '2026-01-01T00:00:00Z', skill_name: 'sum', agent_name: 'A' },
		];
		state.assets = [
			{ id: 'p1', item_type: 'avatar', item_id: 'av1', amount: 5_000_000, currency_mint: 'M', confirmed_at: '2026-01-03T00:00:00Z', created_at: '2026-01-03T00:00:00Z', status: 'confirmed', item_name: 'Cool Avatar' },
		];
		const out = await svc({ id: 'u1' }).getCreatorSalesData();
		expect(out.pending_usd).toBeCloseTo(1.0);
		expect(out.settled_usd).toBeCloseTo(2.5 + 5.0); // royalty settled + asset (5_000_000 / 1e6)
		expect(out.entries).toHaveLength(3);
		// Newest first across both sources.
		expect(out.entries[0].created_at).toBe('2026-01-03T00:00:00Z');
		expect(out.entries[0].skill_name).toBe('Avatar sale');
		expect(out.entries[0].kind).toBe('avatar');
	});

	it('survives the asset_purchases table being absent', async () => {
		state.royalty = [{ id: 'r1', price_usd: '3.00', status: 'settled', created_at: '2026-01-01T00:00:00Z', skill_name: 'echo', agent_name: 'A' }];
		state.assetsThrow = true; // the asset query rejects; the service swallows it
		const out = await svc({ id: 'u1' }).getCreatorSalesData();
		expect(out.settled_usd).toBeCloseTo(3.0);
		expect(out.entries).toHaveLength(1);
	});
});

// ── getAvailableBalance ────────────────────────────────────────────────────────
describe('getAvailableBalance', () => {
	it('delegates to the accounting helper with the current user', async () => {
		monetization.getAvailableBalance.mockResolvedValueOnce({ earned: 9, withdrawn: 1, pending: 0, available: 8 });
		const out = await svc({ id: 'u1' }).getAvailableBalance('MINT');
		expect(out.available).toBe(8);
		expect(monetization.getAvailableBalance).toHaveBeenCalledWith('u1', 'MINT');
	});
});

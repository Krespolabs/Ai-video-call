// Unit tests for the pricing catalog + the charge-three helper — the foundation
// of the $THREE economy. The token rail is mocked: these prove the pricing math,
// the holder-tier discount, the variable-price contract, and the free-forever
// guardrail without needing a live quote/settle.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the token rail so we can assert what charge-three asks of it without RPC/DB.
const issueQuote = vi.fn();
const verifyAndSettlePayment = vi.fn();
vi.mock('../api/_lib/token/index.js', () => ({
	issueQuote: (...a) => issueQuote(...a),
	verifyAndSettlePayment: (...a) => verifyAndSettlePayment(...a),
}));

import { CATALOG, POLICY, priceForAction, catalogEntry, publicCatalog } from '../api/_lib/pricing/catalog.js';
import {
	requireThreePayment,
	isFreeSurface,
	FREE_SURFACES,
} from '../api/_lib/pricing/charge-three.js';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('pricing catalog', () => {
	it('every fixed-price action carries a positive usd and a known policy', () => {
		const policies = new Set(Object.values(POLICY));
		for (const [id, e] of Object.entries(CATALOG)) {
			expect(policies.has(e.policy), `${id} policy`).toBe(true);
			if (e.usd != null) expect(e.usd, `${id} usd`).toBeGreaterThan(0);
		}
	});

	it('forge draft is NOT in the catalog (free-forever lane)', () => {
		expect(CATALOG['forge.draft']).toBeUndefined();
		expect(CATALOG['forge.standard']).toBeDefined();
		expect(CATALOG['forge.high']).toBeDefined();
	});

	it('forge prices are read from forge-tiers (0.15 / 0.50)', () => {
		expect(CATALOG['forge.standard'].usd).toBe(0.15);
		expect(CATALOG['forge.high'].usd).toBe(0.5);
	});

	it('catalogEntry throws a typed 404 for unknown actions', () => {
		expect(() => catalogEntry('nope.nope')).toThrowError(/unknown paid action/);
		try {
			catalogEntry('nope.nope');
		} catch (e) {
			expect(e.status).toBe(404);
			expect(e.code).toBe('unknown_action');
		}
	});

	it('priceForAction applies a holder-tier discount to fixed prices', () => {
		const full = priceForAction('forge.high');
		expect(full.usd).toBe(0.5);
		const discounted = priceForAction('forge.high', { discountBps: 2000 }); // 20% off
		expect(discounted.usd).toBe(0.4);
	});

	it('discount never drops a paid action below the 1-cent floor', () => {
		const p = priceForAction('forge.standard', { discountBps: 10000 });
		expect(p.usd).toBe(0.01);
	});

	it('variable-price actions require a per-call usd', () => {
		expect(() => priceForAction('name.auction')).toThrowError(/per-call usd/);
		const p = priceForAction('name.auction', { usd: 1000 });
		expect(p.usd).toBe(1000);
		expect(p.policy).toBe(POLICY.SCARCITY);
	});

	it('publicCatalog exposes id/label/category/policy/usd for every action', () => {
		const pub = publicCatalog();
		expect(pub.length).toBe(Object.keys(CATALOG).length);
		for (const row of pub) {
			expect(row).toHaveProperty('id');
			expect(row).toHaveProperty('policy');
		}
	});
});

describe('charge-three free-forever guardrail', () => {
	it('flags known free surfaces', () => {
		expect(isFreeSurface('forge.draft')).toBe(true);
		expect(isFreeSurface('chat.free')).toBe(true);
		expect(isFreeSurface('agent.create')).toBe(true);
		expect(isFreeSurface('forge.standard')).toBe(false);
	});

	it('refuses to gate a free-forever surface', async () => {
		await expect(requireThreePayment({ action: 'forge.draft' })).rejects.toMatchObject({
			code: 'free_surface_gated',
		});
		expect(issueQuote).not.toHaveBeenCalled();
	});

	it('the free lane and the paid lane never overlap', () => {
		for (const id of FREE_SURFACES) expect(CATALOG[id]).toBeUndefined();
	});
});

describe('charge-three charge + settle', () => {
	it('CHARGE: issues a $THREE quote priced from the catalog', async () => {
		issueQuote.mockResolvedValue({
			token: 'qtok.sig',
			quote: {
				network: 'mainnet',
				mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
				symbol: '$THREE',
				decimals: 6,
				usd: 0.15,
				priceUsd: 0.001,
				priceSource: 'jupiter',
				total: '150000000',
				legs: [{ role: 'treasury', atomics: '105000000' }, { role: 'rewards', atomics: '45000000' }],
				nonce: 'abc',
			},
			expiresAt: '2026-06-15T00:01:30Z',
		});

		const out = await requireThreePayment({ action: 'forge.standard' });
		expect(out.paid).toBe(false);
		expect(out.quote.usd).toBe(0.15);
		expect(out.quote.quote_token).toBe('qtok.sig');
		expect(issueQuote).toHaveBeenCalledWith(
			expect.objectContaining({ purpose: 'forge.standard', usd: 0.15, splitPolicy: 'consumption' }),
		);
	});

	it('CHARGE: marketplace action without a seller wallet is rejected', async () => {
		await expect(
			requireThreePayment({ action: 'skill.call', usd: 0.01 }),
		).rejects.toMatchObject({ code: 'seller_required' });
		expect(issueQuote).not.toHaveBeenCalled();
	});

	it('SETTLE: verifies the on-chain payment and returns it', async () => {
		verifyAndSettlePayment.mockResolvedValue({ ok: true, payment_id: 'pid-1' });
		const out = await requireThreePayment({
			action: 'forge.standard',
			user: { id: 'u1', wallet_address: 'WALLET' },
			settle: { quoteToken: 'qtok.sig', txSignature: 'x'.repeat(88) },
		});
		expect(out.paid).toBe(true);
		expect(out.payment.payment_id).toBe('pid-1');
		expect(verifyAndSettlePayment).toHaveBeenCalledWith(
			expect.objectContaining({ payerWallet: 'WALLET', userId: 'u1' }),
		);
	});
});

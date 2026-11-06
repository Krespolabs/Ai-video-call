// hasSkillAccess() — NFT-gate branch (api/_lib/skill-access.js).
//
// Verifies that an NFT-gated skill grants access on a held collection, denies
// (with reason 'nft_required') when not held, FAILS CLOSED on a verification
// error ('nft_check_failed'), and denies anonymous callers — all without
// touching the purchase/subscription/trial machinery.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let priceRow; // the row returned by the first SELECT in hasSkillAccess
const sql = vi.fn(async () => (priceRow ? [priceRow] : []));
vi.mock('../../api/_lib/db.js', () => ({ sql, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const userHoldsCollection = vi.fn();
vi.mock('../../api/_lib/nft-gate.js', () => ({ userHoldsCollection }));

const { hasSkillAccess } = await import('../../api/_lib/skill-access.js');

const COLLECTION = 'THREEsynthetic1111111111111111111111111111';

beforeEach(() => {
	sql.mockClear();
	userHoldsCollection.mockReset();
	priceRow = {
		skill: 'premium_skill',
		amount: 0,
		currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		chain: 'solana',
		gate_type: 'nft',
		nft_collection_mint: COLLECTION,
	};
});

describe('hasSkillAccess — NFT gate', () => {
	it('grants access when the user holds the collection', async () => {
		userHoldsCollection.mockResolvedValue(true);
		const res = await hasSkillAccess('user-1', 'agent-1', 'premium_skill');
		expect(res.owned).toBe(true);
		expect(res.via_nft).toBe(true);
		expect(res.gate).toEqual({ type: 'nft', collection: COLLECTION });
		expect(userHoldsCollection).toHaveBeenCalledWith('user-1', COLLECTION);
	});

	it('denies with nft_required when the user does not hold the collection', async () => {
		userHoldsCollection.mockResolvedValue(false);
		const res = await hasSkillAccess('user-1', 'agent-1', 'premium_skill');
		expect(res.owned).toBe(false);
		expect(res.reason).toBe('nft_required');
		expect(res.gate.collection).toBe(COLLECTION);
	});

	it('fails closed (nft_check_failed) when the on-chain check throws', async () => {
		userHoldsCollection.mockRejectedValue(new Error('rpc down'));
		const res = await hasSkillAccess('user-1', 'agent-1', 'premium_skill');
		expect(res.owned).toBe(false);
		expect(res.reason).toBe('nft_check_failed');
	});

	it('denies an anonymous caller without an on-chain check', async () => {
		const res = await hasSkillAccess(null, 'agent-1', 'premium_skill');
		expect(res.owned).toBe(false);
		expect(res.reason).toBe('nft_required');
		expect(userHoldsCollection).not.toHaveBeenCalled();
	});

	it('treats a free (unpriced) skill as owned', async () => {
		priceRow = null;
		const res = await hasSkillAccess('user-1', 'agent-1', 'free_skill');
		expect(res).toEqual({ paid: false, owned: true });
		expect(userHoldsCollection).not.toHaveBeenCalled();
	});
});

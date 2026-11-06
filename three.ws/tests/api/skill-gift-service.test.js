// Gifting — MonetizationService.preparePurchaseTransaction with a recipient.
//
// Pins the gift business rules layered onto the purchase quote: the payer stays
// in user_id while the resolved recipient lands in recipient_user_id, the
// already-owned short-circuit checks the BENEFICIARY (not the payer), and
// gifting yourself is rejected. Lower-level primitives are mocked; the service's
// own SQL runs through a content-addressed mock so call order can't desync.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
	price: null,
	existing: null, // active-access (confirmed/trial) row for the beneficiary | null
	pending: null,
	inserted: null,
};
let calls = [];

function respond(q) {
	if (/FROM agent_skill_prices/i.test(q) && /AND skill =/i.test(q)) return state.price ? [state.price] : [];
	if (/FROM skill_purchases/i.test(q) && /status IN \('confirmed', 'trial'\)/i.test(q))
		return state.existing ? [state.existing] : [];
	if (/FROM skill_purchases/i.test(q) && /status = 'pending'/i.test(q))
		return state.pending ? [state.pending] : [];
	if (/INSERT INTO skill_purchases/i.test(q)) return state.inserted ? [state.inserted] : [];
	return [];
}

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
	calls.push({ q, values });
	return Promise.resolve(respond(q));
});
sqlMock.transaction = vi.fn((queries) => Promise.all(queries));
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const purchaseConfirm = {
	confirmSkillPurchase: vi.fn(async () => ({ status: 'confirmed', tx_signature: 'SIG' })),
	resolvePayoutAddress: vi.fn(async () => 'PAYOUT'),
	logEvent: vi.fn(async () => {}),
};
vi.mock('../../api/_lib/purchase-confirm.js', () => purchaseConfirm);
vi.mock('../../api/_lib/skill-access.js', () => ({ hasSkillAccess: vi.fn(async () => ({ owned: false })) }));
vi.mock('../../api/_lib/monetization.js', () => ({ getAvailableBalance: vi.fn(async () => ({})) }));
vi.mock('../../api/_lib/marketplace-platform-fee.js', () => ({
	resolveMarketplaceFee: vi.fn(async () => ({ bps: 250, feeAtomics: 25000n, recipient: { toBase58: () => 'TREASURY' } })),
}));
vi.mock('../../api/_lib/skill-price-cache.js', () => ({ invalidateSkillPriceCache: vi.fn(() => {}) }));

const { MonetizationService } = await import('../../api/_lib/services/MonetizationService.js');
const svc = (user) => new MonetizationService(user, { sql: sqlMock });

const BUYER = 'buyer-0000';
const RECIPIENT = 'recip-0000';

beforeEach(() => {
	calls = [];
	Object.assign(state, { price: null, existing: null, pending: null, inserted: null });
	vi.clearAllMocks();
});

const findCall = (re) => calls.find((c) => re.test(c.q));

describe('preparePurchaseTransaction — gifting', () => {
	const PRICE = { amount: 1000000, currency_mint: 'MINT', chain: 'solana', mint_decimals: 6 };
	const INSERTED = {
		reference: 'REF', amount: '1000000', currency_mint: 'MINT', chain: 'solana',
		expires_at: 'soon', valid_until: null, platform_fee_amount: '25000', platform_fee_wallet: 'TREASURY',
	};

	it('rejects gifting yourself with 400 cannot_gift_self', async () => {
		state.price = PRICE;
		await expect(
			svc({ id: BUYER }).preparePurchaseTransaction('a1', 'echo', { recipientUserId: BUYER }),
		).rejects.toMatchObject({ status: 400, code: 'cannot_gift_self' });
		expect(findCall(/INSERT INTO skill_purchases/i)).toBeUndefined();
	});

	it('records the recipient on the inserted purchase row, payer stays the buyer', async () => {
		state.price = PRICE;
		state.inserted = INSERTED;
		const out = await svc({ id: BUYER }).preparePurchaseTransaction('a1', 'echo', { recipientUserId: RECIPIENT });

		expect(out.already_owned).toBe(false);
		expect(out.is_gift).toBe(true);
		expect(out.gift_recipient_id).toBe(RECIPIENT);

		const ins = findCall(/INSERT INTO skill_purchases/i);
		expect(ins, 'a skill_purchases INSERT must be issued').toBeTruthy();
		expect(ins.values[0]).toBe(BUYER); // user_id = payer
		expect(ins.values.at(-1)).toBe(RECIPIENT); // recipient_user_id = beneficiary
		expect(purchaseConfirm.logEvent).toHaveBeenCalledWith('REF', 'created', expect.objectContaining({ gift: true }));
	});

	it('checks the BENEFICIARY for already-owned: returns recipient_owns without a reference leak', async () => {
		state.price = PRICE;
		state.existing = { reference: 'RECIP-OLD', status: 'confirmed', tx_signature: 'T', confirmed_at: 'now', valid_until: null, trial_remaining: null, kind: 'purchase' };
		const out = await svc({ id: BUYER }).preparePurchaseTransaction('a1', 'echo', { recipientUserId: RECIPIENT });

		expect(out).toEqual({ already_owned: true, recipient_owns: true });
		// The recipient's own purchase reference/tx must NOT be handed to the buyer.
		expect(out.reference).toBeUndefined();
		expect(out.tx_signature).toBeUndefined();
		// The already-owned query keys on the beneficiary, not the payer.
		const ownedQuery = findCall(/status IN \('confirmed', 'trial'\)/i);
		expect(ownedQuery.values).toContain(RECIPIENT);
		expect(ownedQuery.values).not.toContain(BUYER);
		expect(findCall(/INSERT INTO skill_purchases/i)).toBeUndefined();
	});

	it('a normal (non-gift) purchase is unchanged: no recipient, no gift flags', async () => {
		state.price = PRICE;
		state.inserted = INSERTED;
		const out = await svc({ id: BUYER }).preparePurchaseTransaction('a1', 'echo');
		expect(out.is_gift).toBeUndefined();
		expect(out.gift_recipient_id).toBeUndefined();
		const ins = findCall(/INSERT INTO skill_purchases/i);
		expect(ins.values[0]).toBe(BUYER);
		expect(ins.values.at(-1)).toBeNull(); // recipient_user_id null for a self-purchase
	});
});

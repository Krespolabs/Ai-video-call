// Unit tests for the prepaid credit ledger (api/_lib/credits.js).
//
// The DB is mocked: a controllable result queue stands in for Neon so we can
// exercise the money logic (atomic credit/debit return shapes, insufficient-funds
// 402, idempotent replays, and holder-discount pricing) without a live database.
// The $THREE tier module is mocked so the holder discount is a test input. The
// real pricing catalog is used (it's pure) so the discount math is exercised end
// to end.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ queue: [] }));
const tier = vi.hoisted(() => ({ bps: 0 }));

vi.mock('../api/_lib/db.js', () => ({
	// Every sql`...` call shifts the next programmed result off the queue. An
	// Error result rejects (used to simulate a UNIQUE-constraint violation).
	sql: () => {
		const next = db.queue.length ? db.queue.shift() : [];
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/three-tier.js', () => ({
	holderDiscountBps: async () => tier.bps,
}));

const { getCreditAccount, creditAccount, debitCredits, chargeCreditsForAction, refundCredits } =
	await import('../api/_lib/credits.js');

function uniqueViolation() {
	return Object.assign(new Error('duplicate key value violates unique constraint'), {
		code: '23505',
	});
}

beforeEach(() => {
	db.queue.length = 0;
	tier.bps = 0;
});

describe('getCreditAccount', () => {
	it('rejects without a userId', async () => {
		await expect(getCreditAccount(null)).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('parses balance + lifetime totals into numbers, zeros when no row', async () => {
		db.queue.push([]); // no account row yet
		expect(await getCreditAccount('u1')).toMatchObject({
			balanceUsd: 0,
			lifetimeDepositedUsd: 0,
			lifetimeSpentUsd: 0,
		});

		db.queue.push([
			{ balance_usd: '12.500000', lifetime_deposited_usd: '20', lifetime_spent_usd: '7.5' },
		]);
		expect(await getCreditAccount('u1')).toMatchObject({
			balanceUsd: 12.5,
			lifetimeDepositedUsd: 20,
			lifetimeSpentUsd: 7.5,
		});
	});
});

describe('creditAccount', () => {
	it('rejects a non-positive amount', async () => {
		await expect(
			creditAccount({ userId: 'u1', amountUsd: 0, idempotencyKey: 'k' }),
		).rejects.toMatchObject({
			code: 'bad_request',
		});
	});

	it('rejects an unknown kind', async () => {
		await expect(
			creditAccount({ userId: 'u1', amountUsd: 1, kind: 'spend', idempotencyKey: 'k' }),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('credits and returns the new balance + ledger id', async () => {
		db.queue.push([{ id: 'led-1', balance_after: '15.000000' }]);
		const res = await creditAccount({
			userId: 'u1',
			amountUsd: 5,
			kind: 'deposit',
			idempotencyKey: 'deposit:sig1',
		});
		expect(res).toEqual({ balanceUsd: 15, ledgerId: 'led-1', replay: false });
	});

	it('resolves a replayed deposit to the prior row (no double credit)', async () => {
		db.queue.push(uniqueViolation()); // CTE insert hits UNIQUE(idempotency_key)
		db.queue.push([{ id: 'led-1', balance_after: '15.000000' }]); // priorLedger lookup
		const res = await creditAccount({
			userId: 'u1',
			amountUsd: 5,
			kind: 'deposit',
			idempotencyKey: 'deposit:sig1',
		});
		expect(res).toEqual({ balanceUsd: 15, ledgerId: 'led-1', replay: true });
	});
});

describe('debitCredits', () => {
	it('rejects a non-positive amount', async () => {
		await expect(
			debitCredits({ userId: 'u1', amountUsd: 0, idempotencyKey: 'k' }),
		).rejects.toMatchObject({
			code: 'bad_request',
		});
	});

	it('debits and returns the charged amount + new balance', async () => {
		db.queue.push([{ id: 'led-9', balance_after: '4.600000' }]);
		const res = await debitCredits({ userId: 'u1', amountUsd: 0.4, idempotencyKey: 'spend:1' });
		expect(res).toEqual({ balanceUsd: 4.6, ledgerId: 'led-9', replay: false, chargedUsd: 0.4 });
	});

	it('throws a 402 insufficient_credits when the balance is short', async () => {
		db.queue.push([]); // conditional UPDATE matched no row → not enough balance
		db.queue.push([
			{ balance_usd: '0.100000', lifetime_deposited_usd: '1', lifetime_spent_usd: '0.9' },
		]);
		await expect(
			debitCredits({ userId: 'u1', amountUsd: 0.5, idempotencyKey: 'spend:2' }),
		).rejects.toMatchObject({
			status: 402,
			code: 'insufficient_credits',
			available_usd: 0.1,
			required_usd: 0.5,
		});
	});

	it('resolves a replayed charge to the prior row (no double debit)', async () => {
		db.queue.push(uniqueViolation());
		db.queue.push([{ id: 'led-9', balance_after: '4.600000' }]);
		const res = await debitCredits({ userId: 'u1', amountUsd: 0.4, idempotencyKey: 'spend:1' });
		expect(res).toEqual({ balanceUsd: 4.6, ledgerId: 'led-9', replay: true, chargedUsd: 0 });
	});
});

describe('chargeCreditsForAction', () => {
	it('charges the catalog price for an action at full price for a non-holder', async () => {
		tier.bps = 0;
		db.queue.push([{ id: 'led-h', balance_after: '9.500000' }]);
		const res = await chargeCreditsForAction({
			user: { id: 'u1' },
			action: 'forge.high',
			idempotencyKey: 'forge:credits:ref1',
		});
		expect(res.pricedUsd).toBe(0.5); // forge.high = $0.50
		expect(res.discountBps).toBe(0);
		expect(res.chargedUsd).toBe(0.5);
	});

	it('applies the $THREE holder discount to the charge', async () => {
		tier.bps = 2000; // Gold — 20% off
		db.queue.push([{ id: 'led-h', balance_after: '9.600000' }]);
		const res = await chargeCreditsForAction({
			user: { id: 'u1' },
			action: 'forge.high',
			idempotencyKey: 'forge:credits:ref2',
		});
		expect(res.pricedUsd).toBe(0.4); // 0.50 * (1 - 0.20)
		expect(res.discountBps).toBe(2000);
		expect(res.chargedUsd).toBe(0.4);
	});

	it('requires a signed-in user', async () => {
		await expect(
			chargeCreditsForAction({ user: null, action: 'forge.high', idempotencyKey: 'k' }),
		).rejects.toMatchObject({ code: 'unauthorized' });
	});
});

describe('refundCredits', () => {
	it('returns credits as a refund-kind ledger entry', async () => {
		db.queue.push([{ id: 'led-r', balance_after: '10.000000' }]);
		const res = await refundCredits({
			userId: 'u1',
			amountUsd: 0.5,
			idempotencyKey: 'forge:credits:refund:led-h',
		});
		expect(res).toEqual({ balanceUsd: 10, ledgerId: 'led-r', replay: false });
	});
});

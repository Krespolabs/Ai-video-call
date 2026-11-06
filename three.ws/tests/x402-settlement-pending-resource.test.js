// The resource server's half of `settlement_pending`.
//
// settlePayment() sits inside a buyer's open request. When the facilitator says
// "broadcast, outcome unknown", three things must hold or the mechanism does
// more harm than the 502 it replaces:
//
//   1. EXACTLY ONE retry, with the identical body and idempotency key. That
//      identity is what lets the facilitator recognize the retry and reconcile
//      against the signature it already broadcast; a changed key would make it
//      verify and broadcast again. Exactly one, never a loop, because this runs
//      with a client waiting.
//   2. A still-unresolved settle returns `status:'pending'` rather than throwing,
//      so the buyer gets the good they paid for plus the settlement hash.
//   3. Pending is only allowed when the pending record was durably stored. With
//      no record nothing can reconcile it later. Delivering against it would be
//      an unaccountable giveaway, so that case stays a hard failure.
//
// callFacilitator is internal to x402-spec.js and talks over fetch, so the
// facilitator's replies are injected at the fetch boundary (same approach as
// tests/x402-floor-degradation.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
	writes: [],
	writeFails: false,
}));

// `recordResourcePending` goes through the Postgres-backed store; the store's
// own SQL is covered by its module tests, so here only the durable/not-durable
// outcome matters.
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const query = Array.isArray(strings) ? strings.join(' ') : String(strings ?? '');
		if (/INSERT INTO x402_pending_settlements/i.test(query)) {
			h.writes.push({ query, values });
			if (h.writeFails) return Promise.reject(new Error('db unavailable'));
		}
		return Promise.resolve([]);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const REQUIREMENT = {
	network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	payTo: 'RecipientPubkey',
	asset: 'MintPubkey',
	amount: '1000',
	scheme: 'exact',
	resource: 'https://three.ws/api/x402/forge',
};

const reply = (body) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});

// Answer each /settle call from `sequence`, recording what was sent.
function facilitator(sequence) {
	const calls = [];
	const fetchMock = vi.fn(async (url, init) => {
		calls.push({
			url: String(url),
			body: JSON.parse(init.body),
			idempotencyKey: init.headers['Idempotency-Key'],
		});
		const next = sequence[Math.min(calls.length - 1, sequence.length - 1)];
		return reply(next);
	});
	return { calls, fetchMock };
}

async function settleWith(sequence) {
	vi.resetModules();
	h.writes = [];
	process.env.X402_FACILITATOR_URL_SOLANA = 'https://facilitator.test';
	const { calls, fetchMock } = facilitator(sequence);
	vi.stubGlobal('fetch', fetchMock);
	const { settlePayment } = await import('../api/_lib/x402-spec.js');
	try {
		const result = await settlePayment({
			requirement: REQUIREMENT,
			paymentPayload: { x402Version: 2, payload: { transaction: 'dGVzdA==' } },
			verifiedPayer: 'BuyerPubkey',
		});
		return { result, calls, error: null };
	} catch (error) {
		return { result: null, calls, error };
	} finally {
		vi.unstubAllGlobals();
	}
}

const PENDING = { success: false, errorReason: 'settlement_pending', transaction: 'SigAbc' };
const CONFIRMED = {
	success: true,
	transaction: 'SigAbc',
	network: REQUIREMENT.network,
	payer: 'BuyerPubkey',
};

describe('settlePayment on settlement_pending', () => {
	beforeEach(() => {
		h.writeFails = false;
	});

	it('retries once with the identical body and idempotency key', async () => {
		const { result, calls } = await settleWith([PENDING, CONFIRMED]);

		expect(calls).toHaveLength(2);
		expect(calls[0].url).toContain('/settle');
		// Byte-identical retry: same payload, same requirements, same key. Anything
		// else and the facilitator treats it as a new payment to broadcast.
		expect(calls[1].body).toEqual(calls[0].body);
		expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
		expect(calls[0].idempotencyKey).toBeTruthy();
		// The retry resolved, so this is an ordinary settled payment.
		expect(result).toMatchObject({ success: true, transaction: 'SigAbc' });
		expect(result.status).toBeUndefined();
	});

	it('never retries more than once, even if the second answer is also pending', async () => {
		const { calls } = await settleWith([PENDING, PENDING]);
		expect(calls).toHaveLength(2);
	});

	it('returns status pending (not an error) when the retry is still unresolved', async () => {
		const { result, error } = await settleWith([PENDING, PENDING]);

		expect(error).toBeNull();
		expect(result).toMatchObject({
			success: true,
			status: 'pending',
			pending: true,
			transaction: 'SigAbc',
			network: REQUIREMENT.network,
			payer: 'BuyerPubkey',
		});
		// Recorded for /api/cron/x402-settlement-reconcile to close out.
		expect(h.writes).toHaveLength(1);
		expect(h.writes[0].values).toContain('SigAbc');
	});

	it('fails hard when the pending record cannot be stored', async () => {
		h.writeFails = true;
		const { result, error } = await settleWith([PENDING, PENDING]);

		expect(result).toBeNull();
		expect(error).toMatchObject({ code: 'settle_failed', status: 502 });
		// The operator (and the buyer) need the signature that is out there.
		expect(error.message).toContain('SigAbc');
	});

	it('treats a pending reason with no transaction as an ordinary failure', async () => {
		// Nothing to reconcile against, so there is nothing to wait for: this is a
		// failed settle wearing a non-terminal label.
		const { calls, error } = await settleWith([
			{ success: false, errorReason: 'settlement_pending' },
		]);
		expect(calls).toHaveLength(1);
		expect(error).toMatchObject({ code: 'settle_failed' });
	});

	it('does not retry an ordinary settle failure', async () => {
		const { calls, error } = await settleWith([
			{ success: false, errorReason: 'insufficient_funds' },
		]);
		expect(calls).toHaveLength(1);
		expect(error).toMatchObject({ code: 'settle_failed', status: 502 });
	});

	it('leaves a first-attempt success untouched', async () => {
		const { result, calls, error } = await settleWith([CONFIRMED]);
		expect(error).toBeNull();
		expect(calls).toHaveLength(1);
		expect(result).toMatchObject({ success: true, transaction: 'SigAbc' });
		expect(h.writes).toHaveLength(0);
	});
});

describe('isSettlementPending', () => {
	it('requires both the protocol reason and a broadcast transaction', async () => {
		vi.resetModules();
		const { isSettlementPending, SETTLEMENT_PENDING_REASON } = await import(
			'../api/_lib/x402-spec.js'
		);
		expect(SETTLEMENT_PENDING_REASON).toBe('settlement_pending');
		expect(isSettlementPending({ success: false, errorReason: 'settlement_pending', transaction: 's' })).toBe(true);
		expect(isSettlementPending({ success: false, errorReason: 'settlement_pending' })).toBe(false);
		expect(isSettlementPending({ success: false, errorReason: 'other', transaction: 's' })).toBe(false);
		expect(isSettlementPending({ success: true, transaction: 's' })).toBe(false);
		expect(isSettlementPending(null)).toBe(false);
	});
});

describe('encodePaymentResponseHeader with a pending settlement', () => {
	it('tells the buyer the settlement is pending and which signature to watch', async () => {
		vi.resetModules();
		const { encodePaymentResponseHeader } = await import('../api/_lib/x402-spec.js');
		const header = encodePaymentResponseHeader({
			success: true,
			status: 'pending',
			transaction: 'SigAbc',
			network: REQUIREMENT.network,
			payer: 'BuyerPubkey',
		});
		const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
		expect(decoded).toMatchObject({
			success: true,
			status: 'pending',
			transaction: 'SigAbc',
		});
	});
});

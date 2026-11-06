// The reconcile pass that closes out `settlement_pending` rows
// (api/cron/x402-settlement-reconcile.js).
//
// A pending settlement is a payment whose good has already been delivered
// against a transaction whose fate was unknown. This cron is the only thing that
// ever finishes those: confirm the signature, credit the settlement exactly
// once, and surface the one case that costs us money (a delivered payment that
// never landed). Each branch below is a different answer from the chain, and
// getting any of them wrong has a price:
//
//   confirmed but not credited → revenue and SOL burn missing from the books.
//   failed/abandoned left open → the row is re-probed forever and the loss is
//                                never reported.
//   unknown treated as an answer → a payment that was about to land is written
//                                  off while it lands.
//
// The Solana RPC, the credit gate, the store, and the alert sink are mocked; the
// cron's own decision table is what is under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
	rows: [],
	probe: vi.fn(),
	credit: vi.fn(),
	resolved: [],
	alerts: [],
	promoted: [],
}));

vi.mock('../../api/_lib/db.js', () => ({
	sql: () => Promise.resolve([]),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/solana/connection.js', () => ({
	solanaConnection: () => ({ tag: 'conn' }),
}));

vi.mock('../../api/_lib/x402/self-facilitator.js', () => ({
	probeSettlementSignature: (...a) => h.probe(...a),
}));

vi.mock('../../api/_lib/x402/settle-credit.js', () => ({
	claimSettleCredit: (...a) => h.credit(...a),
}));

vi.mock('../../api/_lib/x402/audit-log.js', () => ({
	promotePendingSettlementStatus: async (args) => {
		h.promoted.push(args);
		return 1;
	},
}));

vi.mock('../../api/_lib/alerts.js', () => ({
	sendOpsAlert: async (title, body, opts) => {
		h.alerts.push({ title, body, opts });
	},
}));

vi.mock('../../api/_lib/x402/pending-settlements.js', () => ({
	PENDING_SCOPE_RESOURCE: 'resource',
	listOpenPendingSettlements: async () => h.rows,
	resolvePendingSettlement: async (args) => {
		h.resolved.push(args);
	},
}));

const CRON_SECRET = 'test-cron-secret';

function pendingRow(overrides = {}) {
	return {
		scope: 'resource',
		key: 'key-1',
		tx_sig: 'SigAbc',
		network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
		payer: 'BuyerPubkey',
		pay_to: 'RecipientPubkey',
		mint: 'MintPubkey',
		amount_atomic: '2500',
		fee_lamports: '5000',
		fee_payer: 'FeePayerPubkey',
		resource_url: 'https://three.ws/api/x402/forge',
		idempotency_key: 'idem-1',
		attempts: 0,
		created_at: new Date(Date.now() - 60_000).toISOString(),
		...overrides,
	};
}

async function run() {
	vi.resetModules();
	process.env.CRON_SECRET = CRON_SECRET;
	const handler = (await import('../../api/cron/x402-settlement-reconcile.js')).default;
	let status = 0;
	let body = '';
	const res = {
		statusCode: 200,
		setHeader() {},
		getHeader() {},
		writeHead(s) {
			status = s;
		},
		end(b) {
			body = b || '';
		},
	};
	await handler(
		{
			method: 'GET',
			url: '/api/cron/x402-settlement-reconcile',
			headers: { authorization: `Bearer ${CRON_SECRET}` },
			query: {},
		},
		res,
	);
	return { status: status || res.statusCode, body: body ? JSON.parse(body) : null };
}

describe('x402-settlement-reconcile', () => {
	beforeEach(() => {
		h.rows = [];
		h.resolved = [];
		h.alerts = [];
		h.promoted = [];
		h.probe = vi.fn();
		h.credit = vi.fn(async () => ({ granted: true }));
	});

	it('does no RPC or DB work when nothing is pending', async () => {
		const { status, body } = await run();
		expect(status).toBe(200);
		expect(body).toMatchObject({ ok: true, scanned: 0 });
		expect(h.probe).not.toHaveBeenCalled();
	});

	it('credits a confirmed settlement under the settle idempotency key, with the fee the chain charged', async () => {
		h.rows = [pendingRow()];
		h.probe = vi.fn(async () => ({ state: 'confirmed', feeLamports: 5432 }));

		const { body } = await run();

		expect(body).toMatchObject({ scanned: 1, confirmed: 1, credited: 1 });
		expect(h.credit).toHaveBeenCalledTimes(1);
		const claimed = h.credit.mock.calls[0][0].row;
		expect(claimed).toMatchObject({
			txSig: 'SigAbc',
			// The SAME key the settle used: the credit gate reads a different key on a
			// known signature as a different payment reusing it, and refuses.
			idempotencyKey: 'idem-1',
			// The real fee, not the estimate recorded at broadcast.
			feeLamports: 5432,
			feePayer: 'FeePayerPubkey',
		});
		// bigint columns arrive as strings; the credit row needs a number.
		expect(claimed.amountAtomic).toBe(2500);
		expect(h.resolved).toEqual([
			{ scope: 'resource', key: 'key-1', state: 'confirmed', error: null },
		]);
		// The audit row was written as 'pending' while the outcome was unknown, and
		// every revenue query counts 'success'. Left pending, this payment would
		// never appear in the books.
		expect(h.promoted).toEqual([{ txHash: 'SigAbc', status: 'success' }]);
		expect(h.alerts).toHaveLength(0);
	});

	it('falls back to the recorded fee estimate when the parsed fee is unavailable', async () => {
		h.rows = [pendingRow()];
		h.probe = vi.fn(async () => ({ state: 'confirmed', feeLamports: null }));
		await run();
		expect(h.credit.mock.calls[0][0].row.feeLamports).toBe('5000');
	});

	it('closes a confirmed row even when the credit is refused, and keeps the reason', async () => {
		// Another payment already owns this signature (or the DB could not answer).
		// Re-probing a transaction the chain has already confirmed would never change
		// the verdict, so the row closes with the refusal recorded.
		h.rows = [pendingRow()];
		h.probe = vi.fn(async () => ({ state: 'confirmed', feeLamports: 5000 }));
		h.credit = vi.fn(async () => ({ granted: false, reason: 'signature_already_settled' }));

		const { body } = await run();

		expect(body).toMatchObject({ confirmed: 1, credited: 0 });
		expect(h.resolved[0]).toMatchObject({
			state: 'confirmed',
			error: 'signature_already_settled',
		});
	});

	it('alerts when a delivered payment turns out never to have settled', async () => {
		h.rows = [pendingRow({ scope: 'resource' })];
		h.probe = vi.fn(async () => ({ state: 'abandoned', error: 'not_found_after_600s' }));

		const { body } = await run();

		expect(body).toMatchObject({ abandoned: 1 });
		expect(h.credit).not.toHaveBeenCalled();
		expect(h.resolved[0]).toMatchObject({ state: 'abandoned' });
		expect(h.promoted).toEqual([{ txHash: 'SigAbc', status: 'failed' }]);
		expect(h.alerts).toHaveLength(1);
		// The signature and the resource are what an operator needs to trace it.
		expect(h.alerts[0].body).toContain('SigAbc');
		expect(h.alerts[0].body).toContain('/api/x402/forge');
		expect(h.alerts[0].opts.signature).toContain('SigAbc');
	});

	it('does not alert for a facilitator-scope row, where nothing was delivered on credit', async () => {
		h.rows = [pendingRow({ scope: 'facilitator', key: 'fkey' })];
		h.probe = vi.fn(async () => ({ state: 'failed', error: 'InstructionError' }));

		const { body } = await run();

		expect(body).toMatchObject({ failed: 1 });
		expect(h.resolved[0]).toMatchObject({ scope: 'facilitator', state: 'failed' });
		expect(h.alerts).toHaveLength(0);
	});

	it('leaves a still-unknown row open and only bumps its attempt count', async () => {
		h.rows = [pendingRow()];
		h.probe = vi.fn(async () => ({ state: 'pending', error: 'not_found_yet' }));

		const { body } = await run();

		expect(body).toMatchObject({ still_pending: 1, confirmed: 0, abandoned: 0 });
		expect(h.credit).not.toHaveBeenCalled();
		expect(h.resolved[0]).toMatchObject({ state: 'pending', error: 'not_found_yet' });
		// Nothing is decided, so the audit row must stay pending too.
		expect(h.promoted).toHaveLength(0);
	});

	it('treats a thrown probe as unknown rather than an answer', async () => {
		h.rows = [pendingRow()];
		h.probe = vi.fn(async () => {
			throw new Error('rpc exploded');
		});

		const { body } = await run();

		expect(body).toMatchObject({ still_pending: 1 });
		expect(h.resolved[0].state).toBe('pending');
		expect(h.resolved[0].error).toContain('probe_failed');
	});

	it('processes every row in the batch independently', async () => {
		h.rows = [
			pendingRow({ key: 'a', tx_sig: 'SigA' }),
			pendingRow({ key: 'b', tx_sig: 'SigB' }),
			pendingRow({ key: 'c', tx_sig: 'SigC' }),
		];
		h.probe = vi.fn(async ({ signature }) => {
			if (signature === 'SigA') return { state: 'confirmed', feeLamports: 5000 };
			if (signature === 'SigB') return { state: 'failed', error: 'reverted' };
			return { state: 'pending', error: 'not_found_yet' };
		});

		const { body } = await run();

		expect(body).toMatchObject({ scanned: 3, confirmed: 1, failed: 1, still_pending: 1 });
		expect(h.resolved.map((r) => r.key)).toEqual(['a', 'b', 'c']);
		// One alert for the one delivered-but-unsettled payment, not one per row.
		expect(h.alerts).toHaveLength(1);
	});

	it('refuses an unauthenticated caller before touching anything', async () => {
		h.rows = [pendingRow()];
		vi.resetModules();
		process.env.CRON_SECRET = CRON_SECRET;
		const handler = (await import('../../api/cron/x402-settlement-reconcile.js')).default;
		let status = 0;
		const res = {
			statusCode: 200,
			setHeader() {},
			getHeader() {},
			writeHead(s) {
				status = s;
			},
			end() {},
		};
		await handler({ method: 'GET', url: '/x', headers: {}, query: {} }, res);
		expect(status || res.statusCode).toBe(401);
		expect(h.probe).not.toHaveBeenCalled();
	});
});

// /api/_lib/club/sweep.js — runClubPayoutSweep behavior.
//
// We test the sweep at the sweep-function level (not via the HTTP handler)
// because that's where the interesting logic lives: dust threshold, claim
// before send, ledger insert, per-dancer error isolation.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── sql mock ─────────────────────────────────────────────────────────────
// Queue-based: each tagged-template call consumes one entry. The first arg
// is the strings array; we use it to route mocks to the matching query.

const sqlCalls = [];
const sqlMock = vi.fn(async (strings, ...values) => {
	const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
	const call = { sql, values };
	sqlCalls.push(call);
	const handler = sqlRouter(sql);
	return handler ? handler(values, call) : [];
});

vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000' },
}));

vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));

// We never want the real on-chain senders to load — they import heavy SDKs.
vi.mock('../../api/_lib/club/payouts.js', () => ({
	sendClubPayout: vi.fn(),
	sendClubUsdcSolana: vi.fn(),
	sendClubUsdcBase: vi.fn(),
}));

const { runClubPayoutSweep, DUST_THRESHOLD_ATOMICS } = await import('../../api/_lib/club/sweep.js');

// ── Mock state ────────────────────────────────────────────────────────────

let mockState;

function resetMockState() {
	mockState = {
		dancers: [],       // [{ dancer, display_name, evm_address, solana_address }]
		groups: [],        // unpaid groups as the cron will see them
		claims: new Map(), // claimToken → array of claimed ids
		ledger: [],        // club_payouts inserts captured here
		paidUpdates: [],   // paid_tx = signature updates
		recountTotal: null, // override recount sum
	};
}

function sqlRouter(sql) {
	// 1. syncDancerWalletsFromEnv — read step
	if (/select dancer, evm_address, solana_address from club_dancer_wallets/.test(sql)) {
		return () => mockState.dancers.map((d) => ({
			dancer: d.dancer,
			evm_address: d.evm_address,
			solana_address: d.solana_address,
		}));
	}
	// 2. syncDancerWalletsFromEnv — write step (no-op for tests)
	if (/update club_dancer_wallets/.test(sql)) {
		return () => [];
	}
	// 3. Main group query
	if (/from club_tips t/.test(sql) && /group by/.test(sql) && /having/.test(sql)) {
		return () => mockState.groups;
	}
	// 4. Claim step: update club_tips set paid_at = now(), paid_tx = $1 ...
	if (/update club_tips/.test(sql) && /paid_at = now\(\)/.test(sql) && /returning id/.test(sql)) {
		return ([token, ids]) => {
			const claimedIds = [...ids];
			mockState.claims.set(token, claimedIds);
			return claimedIds.map((id) => ({ id }));
		};
	}
	// 5. Recount after claim (sum check)
	if (/select coalesce\(sum\(amount_atomics\), 0\)/.test(sql) && /from club_tips/.test(sql)) {
		return () => [{ total: mockState.recountTotal != null
			? mockState.recountTotal
			: mockState.groups[0]?.total_atomics || '0' }];
	}
	// 6. Insert into club_payouts
	if (/insert into club_payouts/.test(sql)) {
		return (values) => {
			mockState.ledger.push({
				dancer: values[0],
				network: values[1],
				asset: values[2],
				amount_atomics: values[3],
				tx: values[4],
				swept_tip_count: values[5],
			});
			return [];
		};
	}
	// 7. Rollback claim on send failure (must come before the settle
	//    branch — the rollback SQL also contains `and paid_tx = `).
	if (/update club_tips/.test(sql) && /set paid_at = null/.test(sql)) {
		return (values) => {
			mockState.paidUpdates.push({ rollback: values[1] });
			return [];
		};
	}
	// 8. Settle paid_tx = real signature
	if (/update club_tips/.test(sql) && /set paid_tx = /.test(sql) && /and paid_tx = /.test(sql)) {
		return (values) => {
			mockState.paidUpdates.push({ signature: values[0], claimToken: values[2] });
			return [];
		};
	}
	return null;
}

// ── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
	sqlCalls.length = 0;
	sqlMock.mockClear();
	resetMockState();
	mockState.dancers = [
		{ dancer: '1', display_name: 'Nyx',    evm_address: '0x' + '11'.repeat(20), solana_address: 'SoLaNa1111111111111111111111111111111111111' },
		{ dancer: '2', display_name: 'Ari',    evm_address: null, solana_address: 'SoLaNa2222222222222222222222222222222222222' },
	];
});

describe('runClubPayoutSweep', () => {
	it('skips groups below the dust threshold (database HAVING filter)', async () => {
		// Mimic the SQL HAVING filter: cron query simply returns no groups
		// when totals are below threshold. Sweep must do nothing.
		mockState.groups = [];

		const send = vi.fn();
		const summary = await runClubPayoutSweep({ send });

		expect(send).not.toHaveBeenCalled();
		expect(summary.paid).toEqual([]);
		expect(summary.groups_considered).toBe(0);
		expect(summary.total_atomics_sent).toBe('0');
	});

	it('sweeps a group above dust → sends, inserts ledger, marks tips paid', async () => {
		const tipIds = ['tip-a', 'tip-b', 'tip-c'];
		const total = (DUST_THRESHOLD_ATOMICS * 2n).toString();
		mockState.groups = [{
			dancer: '1',
			display_name: 'Nyx',
			evm_address: mockState.dancers[0].evm_address,
			solana_address: mockState.dancers[0].solana_address,
			network: 'solana',
			asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			tip_ids: tipIds,
			total_atomics: total,
			tip_count: 3,
		}];
		mockState.recountTotal = total;

		const send = vi.fn().mockResolvedValue({
			signature: 'sigSOL123',
			network: 'solana',
			amount_atomics: total,
		});

		const summary = await runClubPayoutSweep({ send });

		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0][0]).toMatchObject({
			network: 'solana',
			recipient: mockState.dancers[0].solana_address,
			amount: BigInt(total),
		});
		expect(mockState.ledger).toHaveLength(1);
		expect(mockState.ledger[0]).toMatchObject({
			dancer: '1',
			network: 'solana',
			amount_atomics: total,
			tx: 'sigSOL123',
			swept_tip_count: 3,
		});
		expect(summary.paid).toHaveLength(1);
		expect(summary.paid[0]).toMatchObject({
			dancer: '1',
			tx: 'sigSOL123',
			tip_count: 3,
		});
		expect(summary.total_atomics_sent).toBe(total);
		// Settle update must have run with the real signature.
		const settle = mockState.paidUpdates.find((u) => u.signature === 'sigSOL123');
		expect(settle).toBeTruthy();
	});

	it('sweeps a settled tip whose network is the CAIP-2 id (solana:…), not the bare key', async () => {
		// Regression: a settled x402 tip stores network as the CAIP-2 chain id.
		// The sweep must normalize it to 'solana' so the Solana wallet + sender
		// are chosen — previously this fell through to the EVM branch and was
		// skipped as "no wallet" even with a Solana address registered.
		const total = (DUST_THRESHOLD_ATOMICS * 5n).toString();
		mockState.groups = [{
			dancer: '1',
			display_name: 'Nyx',
			evm_address: null, // no EVM wallet — only Solana is registered
			solana_address: mockState.dancers[0].solana_address,
			network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
			asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			tip_ids: ['tip-caip-1', 'tip-caip-2'],
			total_atomics: total,
			tip_count: 2,
		}];
		mockState.recountTotal = total;

		const send = vi.fn().mockResolvedValue({
			signature: 'sigCAIP', network: 'solana', amount_atomics: total,
		});

		const summary = await runClubPayoutSweep({ send });

		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0][0]).toMatchObject({
			network: 'solana',
			recipient: mockState.dancers[0].solana_address,
			amount: BigInt(total),
		});
		expect(summary.skipped).toHaveLength(0);
		expect(summary.paid).toHaveLength(1);
		expect(summary.paid[0]).toMatchObject({ dancer: '1', tx: 'sigCAIP' });
		// Ledger records the normalized chain key, not the CAIP-2 blob.
		expect(mockState.ledger[0].network).toBe('solana');
	});

	it('skips a (dancer, network) group when the recipient wallet is missing', async () => {
		const total = (DUST_THRESHOLD_ATOMICS * 3n).toString();
		mockState.groups = [{
			dancer: '2',
			display_name: 'Ari',
			evm_address: null,                                       // ← missing
			solana_address: mockState.dancers[1].solana_address,
			network: 'base',
			asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			tip_ids: ['tip-x'],
			total_atomics: total,
			tip_count: 1,
		}];

		const send = vi.fn();
		const summary = await runClubPayoutSweep({ send });

		expect(send).not.toHaveBeenCalled();
		expect(mockState.ledger).toHaveLength(0);
		expect(summary.skipped).toHaveLength(1);
		expect(summary.skipped[0]).toMatchObject({
			dancer: '2',
			network: 'base',
			reason: 'no_wallet',
		});
	});

	it('isolates per-dancer errors — one bad sweep does not block the others', async () => {
		const total = (DUST_THRESHOLD_ATOMICS * 4n).toString();
		mockState.groups = [
			{
				dancer: '1',
				display_name: 'Nyx',
				evm_address: mockState.dancers[0].evm_address,
				solana_address: mockState.dancers[0].solana_address,
				network: 'solana',
				asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				tip_ids: ['t-a'],
				total_atomics: total,
				tip_count: 1,
			},
			{
				dancer: '1',
				display_name: 'Nyx',
				evm_address: mockState.dancers[0].evm_address,
				solana_address: mockState.dancers[0].solana_address,
				network: 'base',
				asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
				tip_ids: ['t-b'],
				total_atomics: total,
				tip_count: 1,
			},
		];
		mockState.recountTotal = total;

		const send = vi.fn()
			.mockRejectedValueOnce(new Error('solana RPC blew up'))
			.mockResolvedValueOnce({ signature: '0xBASE_OK', network: 'base', amount_atomics: total });

		const summary = await runClubPayoutSweep({ send });

		expect(send).toHaveBeenCalledTimes(2);
		expect(summary.errored).toHaveLength(1);
		expect(summary.errored[0]).toMatchObject({ dancer: '1', network: 'solana' });
		expect(summary.paid).toHaveLength(1);
		expect(summary.paid[0]).toMatchObject({ dancer: '1', network: 'base', tx: '0xBASE_OK' });
		// Ledger only got the successful row.
		expect(mockState.ledger).toHaveLength(1);
		expect(mockState.ledger[0].network).toBe('base');
		// Rollback recorded for the failing Solana sweep.
		const rollback = mockState.paidUpdates.find((u) => u.rollback);
		expect(rollback).toBeTruthy();
	});
});

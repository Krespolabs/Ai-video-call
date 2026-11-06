// Pure-logic tests for the on-chain leak classifier
// (api/cron/x402-ring-leak-scan.js → classifyWalletDebits).
//
// The classifier decides, for a single parsed transaction, whether each debit
// FROM a ring wallet is internal (counterparty controlled), a network fee, or a
// LEAK (funds left the controlled set) — plus SPL Approve delegation risk. These
// tests feed it synthetic jsonParsed transaction shapes (SYNTHETIC addresses
// only, no real mints or wallets) and assert the six canonical classifications.
//
// Also covers cursor resumption at the scanWallet level (mocked RPC + DB) and
// the fee-divergence helper.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// scanWallet touches db.js (loadCursor/saveCursor/upsertVerdict) and alerts.js.
// Mock both so the cursor-resumption test is deterministic and offline.
const sqlCalls = [];
const sqlQueue = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlCalls.push({ text: strings.join('?'), values });
		return sqlQueue.length ? sqlQueue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn(async () => {}) }));

const {
	classifyWalletDebits,
	accountKeyStrings,
	feeDivergence,
	scanWallet,
} = await import('../api/cron/x402-ring-leak-scan.js');
const { sendOpsAlert } = await import('../api/_lib/alerts.js');

// ── Synthetic universe ────────────────────────────────────────────────────────
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // canonical mint the classifier defaults to
const OTHER_MINT = 'OtherMint1111111111111111111111111111111111';
const PAYER = 'RingPayer111111111111111111111111111111111';
const PAYER_ATA = 'RingPayerAta1111111111111111111111111111111';
const TREASURY = 'RingTreasury11111111111111111111111111111111';
const TREASURY_ATA = 'RingTreasuryAta111111111111111111111111111';
const SPONSOR = 'RingSponsor11111111111111111111111111111111';
const UNKNOWN = 'ExternalStranger1111111111111111111111111111';
const UNKNOWN_ATA = 'ExternalStrangerAta11111111111111111111111';
const DELEGATE = 'MaliciousDelegate11111111111111111111111111';

// Everything the platform controls (owners + ATAs). PAYER/TREASURY/SPONSOR are
// internal; UNKNOWN is not.
const ALLOWED = new Set([PAYER, PAYER_ATA, TREASURY, TREASURY_ATA, SPONSOR]);

function baseMeta(overrides = {}) {
	return {
		fee: 5000,
		err: null,
		preBalances: [100_000_000],
		postBalances: [99_995_000], // -5000 = fee only
		preTokenBalances: [],
		postTokenBalances: [],
		innerInstructions: [],
		...overrides,
	};
}

function tx({ signature = 'sig', keys, instructions = [], meta }) {
	return {
		transaction: {
			signatures: [signature],
			message: { accountKeys: keys.map((pubkey) => ({ pubkey })), instructions },
		},
		meta,
	};
}

describe('classifyWalletDebits — the six canonical cases', () => {
	it('1. internal USDC transfer (payer → treasury) classifies internal, no leak', () => {
		const t = tx({
			keys: [PAYER, PAYER_ATA, TREASURY_ATA],
			instructions: [{
				program: 'spl-token',
				parsed: { type: 'transferChecked', info: { source: PAYER_ATA, destination: TREASURY_ATA, authority: PAYER, mint: USDC, tokenAmount: { amount: '1000000', decimals: 6 } } },
			}],
			meta: baseMeta({
				preTokenBalances: [
					{ accountIndex: 1, mint: USDC, owner: PAYER, uiTokenAmount: { amount: '5000000' } },
					{ accountIndex: 2, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: '0' } },
				],
				postTokenBalances: [
					{ accountIndex: 1, mint: USDC, owner: PAYER, uiTokenAmount: { amount: '4000000' } },
					{ accountIndex: 2, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: '1000000' } },
				],
			}),
		});
		const r = classifyWalletDebits(t, { wallet: PAYER, allowed: ALLOWED, usdcMint: USDC });
		expect(r.unreadable).toBe(false);
		const leaks = r.events.filter((e) => e.type === 'leak');
		expect(leaks).toHaveLength(0);
		const usdcEvent = r.events.find((e) => e.asset === 'USDC');
		expect(usdcEvent).toMatchObject({ type: 'internal', counterparty: TREASURY, amountAtomic: 1_000_000 });
	});

	it('2. fee-only tx: network fee attributed, no debit events', () => {
		const t = tx({
			keys: [SPONSOR],
			instructions: [{ program: 'spl-memo', parsed: { type: 'memo', info: {} } }],
			meta: baseMeta(), // -5000 lamports = fee exactly
		});
		const r = classifyWalletDebits(t, { wallet: SPONSOR, allowed: ALLOWED, usdcMint: USDC });
		expect(r.fee).toEqual({ lamports: 5000, ours: true });
		expect(r.events).toHaveLength(0);
	});

	it('3. USDC to an unknown address is a LEAK', () => {
		const t = tx({
			keys: [PAYER, PAYER_ATA, UNKNOWN_ATA],
			instructions: [{
				program: 'spl-token',
				parsed: { type: 'transferChecked', info: { source: PAYER_ATA, destination: UNKNOWN_ATA, authority: PAYER, mint: USDC, tokenAmount: { amount: '2000000', decimals: 6 } } },
			}],
			meta: baseMeta({
				preTokenBalances: [
					{ accountIndex: 1, mint: USDC, owner: PAYER, uiTokenAmount: { amount: '5000000' } },
					{ accountIndex: 2, mint: USDC, owner: UNKNOWN, uiTokenAmount: { amount: '0' } },
				],
				postTokenBalances: [
					{ accountIndex: 1, mint: USDC, owner: PAYER, uiTokenAmount: { amount: '3000000' } },
					{ accountIndex: 2, mint: USDC, owner: UNKNOWN, uiTokenAmount: { amount: '2000000' } },
				],
			}),
		});
		const r = classifyWalletDebits(t, { wallet: PAYER, allowed: ALLOWED, usdcMint: USDC });
		const leak = r.events.find((e) => e.type === 'leak');
		expect(leak).toMatchObject({ asset: 'USDC', counterparty: UNKNOWN, amountAtomic: 2_000_000, reason: 'usdc_to_unknown' });
	});

	it('4. non-USDC token out is a LEAK even to a controlled counterparty', () => {
		const t = tx({
			keys: [PAYER, PAYER_ATA, TREASURY_ATA],
			instructions: [{
				program: 'spl-token',
				parsed: { type: 'transferChecked', info: { source: PAYER_ATA, destination: TREASURY_ATA, authority: PAYER, mint: OTHER_MINT, tokenAmount: { amount: '777', decimals: 0 } } },
			}],
			meta: baseMeta({
				preTokenBalances: [
					{ accountIndex: 1, mint: OTHER_MINT, owner: PAYER, uiTokenAmount: { amount: '1000' } },
					{ accountIndex: 2, mint: OTHER_MINT, owner: TREASURY, uiTokenAmount: { amount: '0' } },
				],
				postTokenBalances: [
					{ accountIndex: 1, mint: OTHER_MINT, owner: PAYER, uiTokenAmount: { amount: '223' } },
					{ accountIndex: 2, mint: OTHER_MINT, owner: TREASURY, uiTokenAmount: { amount: '777' } },
				],
			}),
		});
		const r = classifyWalletDebits(t, { wallet: PAYER, allowed: ALLOWED, usdcMint: USDC });
		const leak = r.events.find((e) => e.type === 'leak');
		expect(leak).toMatchObject({ asset: OTHER_MINT, amountAtomic: 777, reason: 'non_usdc_token_out' });
	});

	it('5. SPL Approve on a ring ATA raises a delegation alert', () => {
		const t = tx({
			keys: [PAYER, PAYER_ATA, DELEGATE],
			instructions: [{
				program: 'spl-token',
				parsed: { type: 'approve', info: { source: PAYER_ATA, delegate: DELEGATE, owner: PAYER, amount: '1000000' } },
			}],
			meta: baseMeta(),
		});
		const r = classifyWalletDebits(t, { wallet: PAYER, allowed: ALLOWED, usdcMint: USDC });
		const deleg = r.events.find((e) => e.type === 'delegation');
		expect(deleg).toMatchObject({ counterparty: DELEGATE, amountAtomic: 1_000_000, reason: 'spl_approve_on_ring_ata' });
	});
});

describe('classifyWalletDebits — additional leak vectors', () => {
	it('System transfer of SOL to an unknown address is a LEAK', () => {
		const t = tx({
			keys: [PAYER, UNKNOWN],
			instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: PAYER, destination: UNKNOWN, lamports: 3_000_000 } } }],
			meta: baseMeta({ preBalances: [100_000_000, 0], postBalances: [96_995_000, 3_000_000] }),
		});
		const r = classifyWalletDebits(t, { wallet: PAYER, allowed: ALLOWED, usdcMint: USDC });
		const leak = r.events.find((e) => e.type === 'leak');
		expect(leak).toMatchObject({ asset: 'SOL', counterparty: UNKNOWN, amountAtomic: 3_000_000, reason: 'system_transfer_to_unknown' });
	});

	it('unexplained SOL debit (no instruction) is a LEAK', () => {
		const t = tx({
			keys: [PAYER],
			instructions: [],
			meta: baseMeta({ preBalances: [100_000_000], postBalances: [90_000_000] }), // -10M, fee only 5000
		});
		const r = classifyWalletDebits(t, { wallet: PAYER, allowed: ALLOWED, usdcMint: USDC });
		const leak = r.events.find((e) => e.type === 'leak');
		expect(leak).toMatchObject({ asset: 'SOL', reason: 'unexplained_sol_debit' });
		expect(leak.amountAtomic).toBe(10_000_000 - 5_000);
	});

	it('failed tx (meta.err set) yields the fee only, no debit events', () => {
		const t = tx({
			keys: [PAYER, UNKNOWN],
			instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: PAYER, destination: UNKNOWN, lamports: 3_000_000 } } }],
			meta: baseMeta({ err: { InstructionError: [0, 'Custom'] } }),
		});
		const r = classifyWalletDebits(t, { wallet: PAYER, allowed: ALLOWED, usdcMint: USDC });
		expect(r.events).toHaveLength(0);
		expect(r.fee.ours).toBe(true);
	});

	it('missing meta → unreadable (retried next run)', () => {
		const r = classifyWalletDebits({ transaction: { signatures: ['s'], message: { accountKeys: [] } }, meta: null }, { wallet: PAYER, allowed: ALLOWED, usdcMint: USDC });
		expect(r.unreadable).toBe(true);
	});
});

describe('accountKeyStrings', () => {
	it('normalizes jsonParsed {pubkey} and raw-string keys', () => {
		expect(accountKeyStrings({ accountKeys: [{ pubkey: 'A' }, 'B'] })).toEqual(['A', 'B']);
		expect(accountKeyStrings({})).toEqual([]);
	});
});

describe('feeDivergence', () => {
	it('is the relative gap, null when a side is unknown or zero', () => {
		expect(feeDivergence(100, 100)).toBe(0);
		expect(feeDivergence(120, 100)).toBeCloseTo(0.1666, 3);
		expect(feeDivergence(100, null)).toBeNull();
		expect(feeDivergence(0, 0)).toBeNull();
	});
});

describe('scanWallet — cursor resumption', () => {
	class FakePublicKey { constructor(v) { this.v = v; } }
	beforeEach(() => {
		sqlCalls.length = 0;
		sqlQueue.length = 0;
		sendOpsAlert.mockClear();
	});

	it('first run passes no `until`; a resumed run passes the stored cursor', async () => {
		// ── Run 1: no cursor. loadCursor → [] (empty).
		const seen = [];
		const conn1 = {
			getSignaturesForAddress: vi.fn(async (_pk, opts) => { seen.push(opts); return [{ signature: 'SIG_NEW', slot: 10, blockTime: 1_700_000_000 }]; }),
			getParsedTransactions: vi.fn(async () => [tx({ signature: 'SIG_NEW', keys: [PAYER], instructions: [], meta: baseMeta() })]),
		};
		sqlQueue.push([]);       // loadCursor → no row
		sqlQueue.push([]);       // saveCursor upsert
		await scanWallet(conn1, FakePublicKey, PAYER, { allowed: ALLOWED, usdcMint: USDC, runId: 'run-1', feeByDay: new Map() });
		expect(conn1.getSignaturesForAddress).toHaveBeenCalledTimes(1);
		expect(seen[0]).not.toHaveProperty('until');
		// saveCursor persisted the newest signature.
		const savedNew = sqlCalls.find((c) => c.values.includes('SIG_NEW'));
		expect(savedNew).toBeTruthy();

		// ── Run 2: cursor present → getSignaturesForAddress must pass until=SIG_NEW.
		sqlCalls.length = 0;
		const seen2 = [];
		const conn2 = {
			getSignaturesForAddress: vi.fn(async (_pk, opts) => { seen2.push(opts); return []; }),
			getParsedTransactions: vi.fn(async () => []),
		};
		sqlQueue.push([{ last_signature: 'SIG_NEW', scanned_total: 1, leaks_total: 0 }]); // loadCursor
		await scanWallet(conn2, FakePublicKey, PAYER, { allowed: ALLOWED, usdcMint: USDC, runId: 'run-2', feeByDay: new Map() });
		expect(seen2[0]).toMatchObject({ until: 'SIG_NEW' });
	});

	it('a LEAK during scan fires a CRITICAL alert and writes a verdict', async () => {
		sqlCalls.length = 0;
		sqlQueue.push([]); // loadCursor
		const conn = {
			getSignaturesForAddress: vi.fn(async () => [{ signature: 'SIG_LEAK', slot: 5, blockTime: 1_700_000_000 }]),
			getParsedTransactions: vi.fn(async () => [tx({
				signature: 'SIG_LEAK',
				keys: [PAYER, UNKNOWN],
				instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: PAYER, destination: UNKNOWN, lamports: 4_000_000 } } }],
				meta: baseMeta({ preBalances: [100_000_000, 0], postBalances: [95_995_000, 4_000_000] }),
			})]),
		};
		const summary = await scanWallet(conn, FakePublicKey, PAYER, { allowed: ALLOWED, usdcMint: USDC, runId: 'run-3', feeByDay: new Map() });
		expect(summary.leaks).toBe(1);
		expect(sendOpsAlert).toHaveBeenCalledTimes(1);
		expect(sendOpsAlert.mock.calls[0][0]).toMatch(/LEAK/);
		// A verdict row was upserted into payment_reconciliation with our source.
		const verdict = sqlCalls.find((c) => c.values.includes('x402_ring_onchain'));
		expect(verdict).toBeTruthy();
	});
});

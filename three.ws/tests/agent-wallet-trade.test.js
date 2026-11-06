// Integration tests for the discretionary agent-wallet trade endpoint
// (api/agents/solana-trade.js handleTrade, POST /api/agents/:id/solana/trade).
//
// Proves at the handler layer:
//   1. validation (bad side / bad mint)        → 400, key never recovered
//   2. preview                                 → live quote, never signs/sends
//   3. execute without idempotency_key         → 400, key never recovered
//   4. spend-limit breach (per-tx ceiling)     → 403 with the reason, key safe
//   5. insufficient SOL for a buy              → 402 with deposit-able detail
//   6. idempotency replay of a confirmed trade → 200 replayed, never re-sends
//   7. live buy on the bonding curve           → 200 confirmed signature
//
// All Solana RPC, the agent key recovery, the pump SDK builders, and the SOL price
// feed are mocked so the orchestration is deterministic. The shared spend policy
// itself is exercised for real (its own units live in agent-custody-guards.test.js).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-agent-trade';

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const MINT = Keypair.generate().publicKey.toBase58();

// ── auth ────────────────────────────────────────────────────────────────────
const authState = { session: { id: 'owner-1' } };
// The real-funds agreement gate is covered by tests/real-funds-agreement.test.js;
// here the account has signed, so the handler's own guards are what is under test.
vi.mock('../api/_lib/real-funds-agreement.js', () => ({
	requireRealFundsAgreement: vi.fn(async () => true),
	currentSignatureFor: vi.fn(async () => ({ signedAt: '2026-09-17T00:00:00.000Z', signatureName: 'Test Signer', context: null })),
	agreementRequirement: () => ({ version: 2, sign_url: 'https://three.ws/legal/agreements', documents: [] }),
}));

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

// CSRF enforcement is exercised by agent-identity-csrf.test.js; here we mock it
// through so these tests focus on trade guards, spend policy, and execution.
vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => true),
	issueCsrf: vi.fn(async () => ({ token: 'test-csrf', expiresIn: 3600 })),
}));

// ── db ──────────────────────────────────────────────────────────────────────
const sqlState = { queue: [], calls: [] };
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// The behavioral anomaly guard is an additive layer inside enforceSpendLimit; it
// has its own dedicated tests. Stub it so its async DB calls don't consume this
// test's sql queue (it would otherwise shift rows the trade-execution path expects).
vi.mock('../api/_lib/anomaly-events.js', () => ({
	guardOutboundAnomaly: vi.fn(async () => ({ decision: 'allow', verdict: null, anomalyId: null, froze: false })),
}));

// ── rate limit / cache / audit ────────────────────────────────────────────────
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })), walletRead: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));
vi.mock('../api/_lib/cache.js', () => ({ cacheGet: vi.fn(async () => null), cacheSet: vi.fn(async () => {}) }));
vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));

// ── price feed (used by the shared guards' lamportsToUsd) ──────────────────────
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	solUsdPrice: vi.fn(async () => 200), // $200 / SOL
	explorerTxUrl: (sig, net) => `https://explorer/${sig}?n=${net}`,
}));

// ── agent key recovery (spied so we can assert it is NEVER called on a reject) ──
const recoverSpy = vi.fn(async () => Keypair.generate());
vi.mock('../api/_lib/agent-wallet.js', () => ({ recoverSolanaAgentKeypair: recoverSpy }));

// ── Solana RPC (fake connection) ──────────────────────────────────────────────
const connState = {
	balance: 5_000_000_000, // 5 SOL
	blockhash: Keypair.generate().publicKey.toBase58(),
	sig: 'TRADESIG111111111111111111111111111111111111',
	confirmErr: null,
	sent: 0,
};
const fakeConn = {
	getBalance: vi.fn(async () => connState.balance),
	getParsedAccountInfo: vi.fn(async () => ({ value: { data: { parsed: { info: { decimals: 6 } } } } })),
	getAccountInfo: vi.fn(async () => ({ owner: TOKEN_2022 })),
	getLatestBlockhash: vi.fn(async () => ({ blockhash: connState.blockhash, lastValidBlockHeight: 1000 })),
	// The execution engine runs a REAL pre-broadcast simulateTransaction to size the
	// compute-unit budget and reads getRecentPrioritizationFees for the priority fee.
	// The fake conn answers both so the engine's data-driven CU/fee path is exercised
	// (not stubbed) end-to-end against this test's instructions.
	simulateTransaction: vi.fn(async () => ({ value: { err: connState.confirmErr, unitsConsumed: 120_000, logs: [] } })),
	getRecentPrioritizationFees: vi.fn(async () => [{ prioritizationFee: 1_000 }, { prioritizationFee: 2_000 }]),
	sendRawTransaction: vi.fn(async () => { connState.sent += 1; return connState.sig; }),
	confirmTransaction: vi.fn(async () => ({ value: { err: connState.confirmErr } })),
	getSignatureStatuses: vi.fn(async () => ({ value: [{ err: connState.confirmErr, confirmationStatus: 'confirmed', slot: 1 }], context: { slot: 1 } })),
	getBlockHeight: vi.fn(async () => 1),
	getSignatureStatus: vi.fn(async () => ({ value: { err: null, confirmationStatus: 'confirmed' } })),
};
vi.mock('../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => fakeConn),
	solanaPublicConnection: vi.fn(() => fakeConn),
}));

// ── pump quote bridge ──────────────────────────────────────────────────────────
const quoteState = { buy: { tokens: '1000000000', priceImpact: 1.2 }, sell: { sol: '480000000', priceImpact: 0.8 } };
vi.mock('../api/_lib/solana/sdk-bridge.js', () => ({
	getBuyQuote: vi.fn(async () => (quoteState.buy ? { tokens: quoteState.buy.tokens, priceImpact: quoteState.buy.priceImpact } : null)),
	getSellQuote: vi.fn(async () => (quoteState.sell ? { sol: quoteState.sell.sol, priceImpact: quoteState.sell.priceImpact } : null)),
}));
vi.mock('../api/_lib/pump.js', () => ({
	getAmmPoolState: vi.fn(async () => { const e = new Error('no pool'); e.code = 'pool_not_found'; throw e; }),
}));

// ── pump SDK instruction builders (return no-op instructions for the v0 tx) ─────
vi.mock('@pump-fun/pump-sdk', () => {
	class OnlinePumpSdk {
		async fetchGlobal() { return {}; }
		async fetchFeeConfig() { return null; }
		async fetchBuyState() { return { bondingCurve: { quoteMint: PublicKey.default, tokenTotalSupply: 1 }, bondingCurveAccountInfo: {}, associatedUserAccountInfo: null }; }
		async fetchSellState() { return { bondingCurve: { quoteMint: PublicKey.default, tokenTotalSupply: 1 }, bondingCurveAccountInfo: {} }; }
	}
	class PumpSdk {
		async buyV2Instructions() { return []; }
		async sellV2Instructions() { return []; }
	}
	return {
		OnlinePumpSdk, PumpSdk,
		getBuyTokenAmountFromSolAmount: () => ({ gt: () => true, toString: () => '1000000000' }),
		getSellSolAmountFromTokenAmount: () => ({ toString: () => '480000000' }),
	};
});

const { handleTrade } = await import('../api/agents/solana-trade.js');

// ── fake req/res ──────────────────────────────────────────────────────────────
// Streams the JSON body through the same on('data')/on('end') path readJson uses.
function makeReq(body, { method = 'POST', query = '' } = {}) {
	const buf = Buffer.from(JSON.stringify(body || {}));
	return {
		method,
		url: `/api/agents/${AGENT_ID}/solana/trade${query}`,
		headers: { host: 'x', 'content-type': 'application/json' },
		on(evt, cb) {
			if (evt === 'data') queueMicrotask(() => cb(buf));
			if (evt === 'end') queueMicrotask(() => cb());
		},
		destroy() {},
	};
}
function makeRes() {
	return {
		statusCode: 200, headers: {}, body: null, ended: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		status(c) { this.statusCode = c; return this; },
		// http.js json()/error() set res.statusCode then call res.end(<json string>).
		end(d) {
			if (d != null && this.body == null) { try { this.body = JSON.parse(d); } catch { this.body = d; } }
			this.ended = true; return this;
		},
	};
}

function agentRow(extraMeta = {}) {
	return [{ id: AGENT_ID, user_id: 'owner-1', meta: { solana_address: Keypair.generate().publicKey.toBase58(), encrypted_solana_secret: 'enc', ...extraMeta } }];
}

beforeEach(() => {
	sqlState.queue = []; sqlState.calls = [];
	recoverSpy.mockClear();
	connState.balance = 5_000_000_000; connState.sent = 0; connState.confirmErr = null;
	quoteState.buy = { tokens: '1000000000', priceImpact: 1.2 };
	quoteState.sell = { sol: '480000000', priceImpact: 0.8 };
	authState.session = { id: 'owner-1' };
});

describe('handleTrade — validation', () => {
	it('rejects an invalid side without recovering the key', async () => {
		sqlState.queue = [agentRow()];
		const res = makeRes();
		await handleTrade(makeReq({ side: 'hodl', mint: MINT, sol_amount: 0.5 }), res, AGENT_ID);
		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('validation_error');
		expect(recoverSpy).not.toHaveBeenCalled();
	});

	it('rejects a malformed mint', async () => {
		sqlState.queue = [agentRow()];
		const res = makeRes();
		await handleTrade(makeReq({ side: 'buy', mint: 'not-a-mint', sol_amount: 0.5 }), res, AGENT_ID);
		expect(res.statusCode).toBe(400);
		expect(recoverSpy).not.toHaveBeenCalled();
	});

	it('rejects a non-owner', async () => {
		sqlState.queue = [[{ id: AGENT_ID, user_id: 'someone-else', meta: {} }]];
		const res = makeRes();
		await handleTrade(makeReq({ side: 'buy', mint: MINT, sol_amount: 0.5 }), res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(recoverSpy).not.toHaveBeenCalled();
	});
});

describe('handleTrade — preview', () => {
	it('returns a live buy quote and never signs', async () => {
		sqlState.queue = [agentRow()];
		const res = makeRes();
		await handleTrade(makeReq({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.5, slippage_bps: 300 }), res, AGENT_ID);
		expect(res.statusCode).toBe(200);
		expect(res.body.data.preview).toBe(true);
		expect(res.body.data.out.asset).toBe('TOKEN');
		expect(Number(res.body.data.out.amount)).toBeGreaterThan(0);
		expect(res.body.data.price_impact_pct).toBeCloseTo(1.2, 3);
		// minimum received = expected * (1 - 3%)
		expect(Number(res.body.data.min_received.amount)).toBeLessThan(Number(res.body.data.out.amount));
		expect(connState.sent).toBe(0);
		expect(recoverSpy).not.toHaveBeenCalled();
	});

	it('returns a sell quote priced in SOL', async () => {
		sqlState.queue = [agentRow()];
		const res = makeRes();
		await handleTrade(makeReq({ preview: true, side: 'sell', mint: MINT, token_amount_raw: '1000000000', slippage_bps: 500 }), res, AGENT_ID);
		expect(res.statusCode).toBe(200);
		expect(res.body.data.out.asset).toBe('SOL');
		expect(Number(res.body.data.out.amount)).toBeGreaterThan(0);
		expect(recoverSpy).not.toHaveBeenCalled();
	});
});

describe('handleTrade — guards', () => {
	it('requires an idempotency key to execute', async () => {
		sqlState.queue = [agentRow()];
		const res = makeRes();
		await handleTrade(makeReq({ side: 'buy', mint: MINT, sol_amount: 0.5 }), res, AGENT_ID);
		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('validation_error');
		expect(recoverSpy).not.toHaveBeenCalled();
	});

	it('blocks a buy over the per-transaction USD ceiling (403, key safe)', async () => {
		// 0.5 SOL × $200 = $100, over a $10 per-tx cap.
		sqlState.queue = [agentRow({ spend_limits: { per_tx_usd: 10, daily_usd: null, withdraw_allowlist: [] } })];
		const res = makeRes();
		await handleTrade(makeReq({ side: 'buy', mint: MINT, sol_amount: 0.5, slippage_bps: 300, idempotency_key: 'k-1' }), res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(res.body.error).toBe('per_tx_exceeded');
		expect(recoverSpy).not.toHaveBeenCalled();
		expect(connState.sent).toBe(0);
	});

	it('blocks a buy that exceeds the wallet balance (402, key safe)', async () => {
		connState.balance = 100_000; // 0.0001 SOL — far below a 0.5 SOL buy
		sqlState.queue = [agentRow()];
		const res = makeRes();
		await handleTrade(makeReq({ side: 'buy', mint: MINT, sol_amount: 0.5, slippage_bps: 300, idempotency_key: 'k-2' }), res, AGENT_ID);
		expect(res.statusCode).toBe(402);
		expect(res.body.error).toBe('insufficient_sol');
		expect(res.body.balance_lamports).toBeDefined();
		expect(recoverSpy).not.toHaveBeenCalled();
	});
});

describe('handleTrade — idempotency + execution', () => {
	it('replays a confirmed trade with the same key without re-sending', async () => {
		sqlState.queue = [
			agentRow(),
			[{ status: 'confirmed', signature: connState.sig, meta: {} }], // prior row
		];
		const res = makeRes();
		await handleTrade(makeReq({ side: 'buy', mint: MINT, sol_amount: 0.5, slippage_bps: 300, idempotency_key: 'k-dup' }), res, AGENT_ID);
		expect(res.statusCode).toBe(200);
		expect(res.body.data.replayed).toBe(true);
		expect(res.body.data.signature).toBe(connState.sig);
		expect(connState.sent).toBe(0);
		expect(recoverSpy).not.toHaveBeenCalled();
	});

	it('executes a live bonding-curve buy and returns a confirmed signature', async () => {
		sqlState.queue = [
			agentRow(),          // loadOwnedWallet
			[],                  // prior idempotency check → none
			[{ id: 'evt-1' }],   // claim INSERT
			[],                  // updateCustodyEvent (confirmed)
			[],                  // indexTrade: pump_agent_mints lookup → none
		];
		const res = makeRes();
		await handleTrade(makeReq({ side: 'buy', mint: MINT, sol_amount: 0.5, slippage_bps: 300, idempotency_key: 'k-live' }), res, AGENT_ID);
		expect(res.statusCode).toBe(200);
		expect(res.body.data.replayed).toBe(false);
		// The execution engine derives the signature locally from the signed v0 tx
		// (bs58 of its first signature), not from sendRawTransaction's return — so it
		// is a real base58 signature unique to this freshly-recovered keypair. Assert
		// the contract (confirmed, base58, echoed into the explorer link), not a fixed
		// value the engine never promises.
		const sig = res.body.data.signature;
		expect(typeof sig).toBe('string');
		expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);
		expect(res.body.data.explorer).toContain(sig);
		expect(connState.sent).toBe(1);
		expect(recoverSpy).toHaveBeenCalledTimes(1);
	});
});

// Guard-wiring tests for the kept /api/agents/:id/solana/trade endpoint.
//
// After the shared-guardrail refactor this handler enforces the SAME predicates +
// per-agent meta.trade_limits as the flat /api/agents/:id/trade endpoint and the
// sniper. These tests drive it in preview mode (no signing) and on execute to
// prove the kill switch, per-trade cap, daily budget, price-impact breaker, and
// fee headroom all reject through the shared module — auth + ownership too.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Keypair, PublicKey } from '@solana/web3.js';

const AGENT_ADDR = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();

const sqlState = { agent: null, existingCustody: null };
// The real-funds agreement gate is covered by tests/real-funds-agreement.test.js;
// here the account has signed, so the handler's own guards are what is under test.
vi.mock('../api/_lib/real-funds-agreement.js', () => ({
	requireRealFundsAgreement: vi.fn(async () => true),
	currentSignatureFor: vi.fn(async () => ({ signedAt: '2026-09-17T00:00:00.000Z', signatureName: 'Test Signer', context: null })),
	agreementRequirement: () => ({ version: 2, sign_url: 'https://three.ws/legal/agreements', documents: [] }),
}));

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		const q = (typeof strings === 'string' ? strings : strings.join('?')).toLowerCase();
		if (/from agent_identities/.test(q) && /select/.test(q)) return sqlState.agent ? [sqlState.agent] : [];
		if (/from agent_custody_events/.test(q) && /idempotency_key =/.test(q)) return sqlState.existingCustody ? [sqlState.existingCustody] : [];
		if (/sum\(amount_lamports\)/.test(q)) return [{ lamports: '0' }];
		if (/sum\(usd\)/.test(q)) return [{ usd: 0 }];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const authState = { session: { id: 'owner-1' } };
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

// CSRF enforcement is exercised by agent-identity-csrf.test.js; mock it through
// so these tests focus on the trade execution guard ladder.
vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => true),
	issueCsrf: vi.fn(async () => ({ token: 'test-csrf', expiresIn: 3600 })),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })), walletRead: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

vi.mock('../api/_lib/avatar-wallet.js', () => ({
	solUsdPrice: vi.fn(async () => 200),
	explorerTxUrl: (sig, net) => `https://explorer.example/tx/${sig}?cluster=${net}`,
}));

vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../api/_lib/cache.js', () => ({ cacheSet: vi.fn(async () => {}), cacheGet: vi.fn(async () => null) }));

const connState = { balance: 5_000_000_000 };
function fakeConn() {
	return {
		getBalance: vi.fn(async () => connState.balance),
		getParsedAccountInfo: vi.fn(async () => ({ value: { data: { parsed: { info: { decimals: 6 } } } } })),
	};
}
vi.mock('../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => fakeConn()),
	solanaPublicConnection: vi.fn(() => fakeConn()),
}));

const quoteState = { buyImpact: 1, isMayhem: false };
vi.mock('../api/_lib/solana/sdk-bridge.js', () => ({
	getBuyQuote: vi.fn(async () => ({ tokens: '1000000', priceImpact: quoteState.buyImpact, isMayhemMode: quoteState.isMayhem })),
	getSellQuote: vi.fn(async () => ({ sol: '50000000', priceImpact: 1 })),
}));

vi.mock('../api/_lib/pump.js', () => ({ getAmmPoolState: vi.fn(async () => { throw Object.assign(new Error('no pool'), { code: 'pool_not_found' }); }) }));
vi.mock('../api/_lib/pump-platform-fee.js', () => ({ effectivePumpFeeBps: vi.fn(async () => 100) }));

const { handleTrade } = await import('../api/agents/solana-trade.js');

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

function mockRes() {
	return {
		statusCode: 200, _headers: {}, _body: '',
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}
function mockReq(body) {
	const r = Readable.from([Buffer.from(JSON.stringify(body))]);
	r.method = 'POST';
	r.url = `/api/agents/${AGENT_ID}/solana/trade`;
	r.headers = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
	return r;
}
function setAgent(meta = {}) {
	sqlState.agent = { id: AGENT_ID, user_id: 'owner-1', meta: { solana_address: AGENT_ADDR, encrypted_solana_secret: 'ENC::secret', ...meta } };
}
async function call(body) {
	const res = mockRes();
	await handleTrade(mockReq(body), res, AGENT_ID);
	return res;
}

beforeEach(() => {
	sqlState.agent = null;
	sqlState.existingCustody = null;
	authState.session = { id: 'owner-1' };
	connState.balance = 5_000_000_000;
	quoteState.buyImpact = 1;
	quoteState.isMayhem = false;
	setAgent();
});

describe('solana-trade — mayhem-mode coins are unbuyable', () => {
	it('422 mayhem_blocked when the bonding curve is mayhem mode (buy)', async () => {
		quoteState.isMayhem = true;
		const res = await call({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.statusCode).toBe(422);
		expect(res.json.error).toBe('mayhem_blocked');
	});

	it('regular coins still price normally (buy)', async () => {
		quoteState.isMayhem = false;
		const res = await call({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.statusCode).toBe(200);
		expect(res.json.data.venue).toBe('bonding_curve');
	});
});

describe('solana-trade — auth & ownership', () => {
	it('401 for an unauthenticated caller', async () => {
		authState.session = null;
		const res = await call({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.statusCode).toBe(401);
	});
	it('403 for a non-owner', async () => {
		sqlState.agent.user_id = 'someone-else';
		const res = await call({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.statusCode).toBe(403);
	});
});

describe('solana-trade — preview surfaces shared-guard breaches', () => {
	it('kill switch → guard trading_paused', async () => {
		setAgent({ trade_limits: { kill_switch: true } });
		const res = await call({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.statusCode).toBe(200);
		expect(res.json.data.guard?.code).toBe('trading_paused');
	});

	it('over per-trade cap → guard per_trade_cap', async () => {
		setAgent({ trade_limits: { per_trade_sol: 0.05 } });
		const res = await call({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.json.data.guard?.code).toBe('per_trade_cap');
	});

	it('price impact over the configurable breaker → guard price_impact_too_high', async () => {
		quoteState.buyImpact = 40; // default breaker is 15%
		const res = await call({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.json.data.guard?.code).toBe('price_impact_too_high');
		expect(res.json.data.guard?.detail?.max_price_impact_pct).toBe(15);
	});

	it('insufficient SOL → funds insufficient_sol', async () => {
		connState.balance = 0;
		const res = await call({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.json.data.funds?.code).toBe('insufficient_sol');
	});

	it('a clean buy previews with no guard/funds warning', async () => {
		const res = await call({ preview: true, side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.json.data.guard).toBeNull();
		expect(res.json.data.funds).toBeNull();
		expect(res.json.data.price_impact_pct).toBe(1);
	});
});

describe('solana-trade — execute hard-stops on a guard breach (no signing)', () => {
	it('kill switch → 403 before the key is touched', async () => {
		setAgent({ trade_limits: { kill_switch: true } });
		const res = await call({ side: 'buy', mint: MINT, sol_amount: 0.1, idempotency_key: 'k-1' });
		expect(res.statusCode).toBe(403);
		expect(res.json.error).toBe('trading_paused');
	});

	it('over per-trade cap → 422', async () => {
		setAgent({ trade_limits: { per_trade_sol: 0.05 } });
		const res = await call({ side: 'buy', mint: MINT, sol_amount: 0.1, idempotency_key: 'k-2' });
		expect(res.statusCode).toBe(422);
		expect(res.json.error).toBe('per_trade_cap');
	});

	it('price impact over breaker → 422', async () => {
		quoteState.buyImpact = 40;
		const res = await call({ side: 'buy', mint: MINT, sol_amount: 0.1, idempotency_key: 'k-3' });
		expect(res.statusCode).toBe(422);
		expect(res.json.error).toBe('price_impact_too_high');
	});

	it('insufficient SOL → 402', async () => {
		connState.balance = 0;
		const res = await call({ side: 'buy', mint: MINT, sol_amount: 0.1, idempotency_key: 'k-4' });
		expect(res.statusCode).toBe(402);
		expect(res.json.error).toBe('insufficient_sol');
	});

	it('execute without an idempotency key is rejected', async () => {
		const res = await call({ side: 'buy', mint: MINT, sol_amount: 0.1 });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('validation_error');
	});
});

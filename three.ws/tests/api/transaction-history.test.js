// GET /api/users/me/transaction-history — buyer + seller ledger.
//
// The endpoint reads the skill_purchases ledger from two angles: purchases the
// caller made (buyer leg) and sales on agents the caller owns (seller leg),
// merges them, and decorates each row with a decimals-aware settled amount, the
// seller's net (gross − platform fee), and a block-explorer link. These tests
// pin that decoration and the role filter. DB / auth / limiter are mocked so the
// suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

let buyerRows = [];
let sellerRows = [];
let calls = [];

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	calls.push({ q, values });
	if (/'buyer'::text AS role/.test(q)) return Promise.resolve(buyerRows);
	if (/'seller'::text AS role/.test(q)) return Promise.resolve(sellerRows);
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
let bearerUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => bearerUser),
	extractBearer: vi.fn(() => null),
}));

let rlSuccess = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { widgetRead: vi.fn(async () => ({ success: rlSuccess, reset: Date.now() + 1000, limit: 120, remaining: 0 })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: handler } = await import('../../api/users/me/transaction-history.js');

const AGENT_ID = '00000000-0000-4000-8000-000000000abc';
const URL = '/api/users/me/transaction-history';

const findCall = (re) => calls.find((c) => re.test(c.q));

function buyerRow(over = {}) {
	return {
		id: 'p1', agent_id: AGENT_ID, skill: 'web_search', status: 'confirmed', kind: 'purchase',
		amount: '1000000', tipped_amount: null, platform_fee_amount: '50000', mint_decimals: 6,
		currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: 'solana',
		tx_signature: 'SIG_BUY', skill_nft_mint: null,
		confirmed_at: '2026-06-17T10:00:00.000Z', created_at: '2026-06-17T09:59:00.000Z',
		agent_name: 'Helper', agent_thumbnail: null, role: 'buyer', ...over,
	};
}

function sellerRow(over = {}) {
	return {
		id: 's1', agent_id: AGENT_ID, skill: 'summarize', status: 'confirmed', kind: 'purchase',
		amount: '1000000', tipped_amount: null, platform_fee_amount: '50000', mint_decimals: 6,
		currency_mint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', chain: 'base',
		tx_signature: '0xabc123', skill_nft_mint: null,
		confirmed_at: '2026-06-16T10:00:00.000Z', created_at: '2026-06-16T09:59:00.000Z',
		agent_name: 'Helper', agent_thumbnail: null, role: 'seller', ...over,
	};
}

beforeEach(() => {
	sqlMock.mockClear();
	calls = [];
	buyerRows = [];
	sellerRows = [];
	sessionUser = null;
	bearerUser = null;
	rlSuccess = true;
});

describe('auth + input guards', () => {
	it('401s when unauthenticated', async () => {
		const { status, body } = await invoke(handler, { method: 'GET', url: URL });
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(calls).toHaveLength(0);
	});

	it('400s on an unknown role', async () => {
		sessionUser = { id: 'owner-uuid' };
		const { status, body } = await invoke(handler, { method: 'GET', url: `${URL}?role=bogus` });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('429s when rate-limited', async () => {
		sessionUser = { id: 'owner-uuid' };
		rlSuccess = false;
		const { status } = await invoke(handler, { method: 'GET', url: URL });
		expect(status).toBe(429);
	});
});

describe('role filter', () => {
	beforeEach(() => { sessionUser = { id: 'owner-uuid' }; });

	it('role=buyer only runs the buyer leg', async () => {
		buyerRows = [buyerRow()];
		const { status, body } = await invoke(handler, { method: 'GET', url: `${URL}?role=buyer` });
		expect(status).toBe(200);
		expect(findCall(/'buyer'::text AS role/)).toBeDefined();
		expect(findCall(/'seller'::text AS role/)).toBeUndefined();
		expect(body.transactions).toHaveLength(1);
		expect(body.transactions[0].role).toBe('buyer');
	});

	it('role=seller only runs the seller leg', async () => {
		sellerRows = [sellerRow()];
		const { status, body } = await invoke(handler, { method: 'GET', url: `${URL}?role=seller` });
		expect(status).toBe(200);
		expect(findCall(/'seller'::text AS role/)).toBeDefined();
		expect(findCall(/'buyer'::text AS role/)).toBeUndefined();
		expect(body.transactions[0].role).toBe('seller');
	});

	it('role=all merges both legs newest-first', async () => {
		buyerRows = [buyerRow()];   // 2026-06-17
		sellerRows = [sellerRow()]; // 2026-06-16
		const { status, body } = await invoke(handler, { method: 'GET', url: `${URL}?role=all` });
		expect(status).toBe(200);
		expect(body.count).toBe(2);
		expect(body.transactions[0].role).toBe('buyer');  // newer sorts first
		expect(body.transactions[1].role).toBe('seller');
	});
});

describe('row decoration', () => {
	beforeEach(() => { sessionUser = { id: 'owner-uuid' }; });

	it('formats the buyer amount and links to Solscan', async () => {
		buyerRows = [buyerRow()];
		const { body } = await invoke(handler, { method: 'GET', url: `${URL}?role=buyer` });
		const t = body.transactions[0];
		expect(t.amount_display).toBe('1.00');
		expect(t.platform_fee_display).toBe('0.05');
		expect(t.net_display).toBeNull(); // net is a seller concept
		expect(t.explorer_url).toBe('https://solscan.io/tx/SIG_BUY');
	});

	it('reports the seller net (gross − fee) and a Basescan link for EVM', async () => {
		sellerRows = [sellerRow()];
		const { body } = await invoke(handler, { method: 'GET', url: `${URL}?role=seller` });
		const t = body.transactions[0];
		expect(t.amount_display).toBe('1.00');
		expect(t.net_display).toBe('0.95');
		expect(t.explorer_url).toBe('https://basescan.org/tx/0xabc123');
	});

	it('a tipped row reports the amount that actually settled, not the quote', async () => {
		buyerRows = [buyerRow({ status: 'tipped', amount: '2000000', tipped_amount: '1500000' })];
		const { body } = await invoke(handler, { method: 'GET', url: `${URL}?role=buyer` });
		const t = body.transactions[0];
		expect(t.amount_display).toBe('1.50');
		expect(t.amount_atomics).toBe('1500000');
	});

	it('honours a non-6 mint_decimals when formatting', async () => {
		buyerRows = [buyerRow({ amount: '500000000', platform_fee_amount: '0', mint_decimals: 9 })];
		const { body } = await invoke(handler, { method: 'GET', url: `${URL}?role=buyer` });
		expect(body.transactions[0].amount_display).toBe('0.50'); // 5e8 / 1e9
	});
});

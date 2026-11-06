// Endpoint test for GET /api/users/me/tier — drives the real handler with a
// fake req/res and mocked DB / auth / rate-limit / on-chain read. Proves the
// response contract the dashboard tier panel renders against: primary tier,
// stacked badges, next mode, and the full ladder. http.js (json/cors/method/
// wrap) runs for real so the status + envelope are genuinely exercised.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tagged-template `sql` that returns whatever the test queued, in order.
const queue = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async () => (queue.length ? queue.shift() : [])),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// Auth: the test sets `session` / `bearer` per case.
let session = null;
let bearer = null;
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => session),
	authenticateBearer: vi.fn(async () => bearer),
	extractBearer: vi.fn(() => null),
}));

// Rate limiter: always allow.
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { widgetRead: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// On-chain holder read (account-tier.detectHolder → three-tier.holderUsd).
const holderUsd = vi.fn(async () => ({ amount: 0, usd: 0, priceUsd: 0 }));
vi.mock('../api/_lib/three-tier.js', () => ({ holderUsd: (...a) => holderUsd(...a) }));

import handler from '../api/users/me/tier.js';

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) { this.headersSent = true; this.writableEnded = true; this.body = payload; },
		get json() { return this.body ? JSON.parse(this.body) : null; },
	};
}

const req = (over = {}) => ({ method: 'GET', url: '/api/users/me/tier', headers: {}, socket: {}, ...over });

beforeEach(() => {
	queue.length = 0;
	session = null;
	bearer = null;
	vi.clearAllMocks();
	holderUsd.mockResolvedValue({ amount: 0, usd: 0, priceUsd: 0 });
});

describe('GET /api/users/me/tier', () => {
	it('401s with no session or bearer', async () => {
		const res = mockRes();
		await handler(req(), res);
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('unauthorized');
	});

	it('resolves a default account to the user tier with the full ladder', async () => {
		session = { id: 'u1' };
		queue.push([{ id: 'u1', plan: 'free', account_tier: null, wallet_address: null }]); // user row
		queue.push([]); // linked solana wallets

		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		const b = res.json;
		expect(b.tier.id).toBe('user');
		expect(b.badges.map((x) => x.id)).toEqual(['user']);
		expect(b.next.id).toBe('beta');
		expect(b.holder.isHolder).toBe(false);
		expect(b.tiers).toHaveLength(5);
		expect(holderUsd).not.toHaveBeenCalled(); // no wallets → no RPC
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('stacks granted + plan + on-chain holder badges, picking the highest as primary', async () => {
		session = { id: 'u2' };
		queue.push([{ id: 'u2', plan: 'team', account_tier: 'beta', wallet_address: 'LoginWallet111' }]);
		queue.push([{ address: 'LinkedWallet222' }]); // linked solana wallet
		// First wallet holds nothing; the linked one holds $THREE.
		holderUsd
			.mockResolvedValueOnce({ amount: 0, usd: 0, priceUsd: 0 })
			.mockResolvedValueOnce({ amount: 5000, usd: 230, priceUsd: 0.046 });

		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		const b = res.json;
		const ids = b.badges.map((x) => x.id);
		expect(ids).toEqual(['user', 'beta', 'pro', 'holder']); // rank order
		expect(b.tier.id).toBe('holder'); // highest-ranked active
		expect(b.granted).toBe('beta');
		expect(b.holder).toEqual({ isHolder: true, amount: 5000, usd: 230 });
		expect(b.next.id).toBe('three-dimensional');
		expect(holderUsd).toHaveBeenCalledTimes(2); // login + linked wallet
	});

	it('authenticates via Bearer when there is no session', async () => {
		bearer = { userId: 'u3' };
		queue.push([{ id: 'u3', plan: 'pro', account_tier: null, wallet_address: null }]);
		queue.push([]);

		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		expect(res.json.tier.id).toBe('pro');
	});

	it('404s when the user record is gone', async () => {
		session = { id: 'ghost' };
		queue.push([]); // no user row

		const res = mockRes();
		await handler(req(), res);
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('not_found');
	});
});

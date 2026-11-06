// GET /api/crypto/wallet — free wallet-portfolio endpoint.
//
// The balance layer (api/_lib/balances.js) has its own live-RPC + circuit-breaker
// tests; here we pin the ENDPOINT contract: input validation, the mapping from the
// rich internal balance shape to the stable public schema, USD valuation with a
// missing price, the keyless-RPC source label, the empty wallet, truncation, and
// every error state (bad input, unsupported chain, EVM-not-configured, upstream
// down). getBalances + heliusHealth are mocked so no network is touched; the pure
// mapping is what we assert. Fixtures use $THREE (CA in 00-CONTEXT) and a synthetic
// mint — never a real third-party mint.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBalancesMock = vi.fn();
const heliusHealthMock = vi.fn(() => ({ configured: false, available: true, degraded: false }));

vi.mock('../../api/_lib/balances.js', () => ({
	getBalances: (...a) => getBalancesMock(...a),
	heliusHealth: () => heliusHealthMock(),
	// Faithful reimplementation of the real reducer (native + Σ token usd).
	walletUsdTotal: (b) =>
		(b?.native?.usd ?? 0) + (b?.tokens ?? []).reduce((s, t) => s + (t.usd ?? 0), 0),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		cryptoDataIp: vi.fn(async () => ({ success: true })),
		cryptoDataGlobal: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../../api/crypto/wallet.js');
const { limits } = await import('../../api/_lib/rate-limit.js');

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SYNTH = 'THREEsynthetic1111111111111111111111111111';
const WALLET = 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk';

function makeReq(url) {
	return { url, method: 'GET', headers: { host: 'x' } };
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(url) {
	const res = makeRes();
	await handler(makeReq(url), res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

beforeEach(() => {
	getBalancesMock.mockReset();
	heliusHealthMock.mockReturnValue({ configured: false, available: true, degraded: false });
	limits.cryptoDataIp.mockResolvedValue({ success: true });
	limits.cryptoDataGlobal.mockResolvedValue({ success: true });
});

describe('GET /api/crypto/wallet — validation', () => {
	it('400s with an example when address is missing', async () => {
		const { res, body } = await call('/api/crypto/wallet');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('missing_address');
		expect(body.example).toContain('/api/crypto/wallet?address=');
		expect(getBalancesMock).not.toHaveBeenCalled();
	});

	it('400s on a syntactically invalid Solana address before any upstream call', async () => {
		const { res, body } = await call('/api/crypto/wallet?address=not-a-real-address&chain=solana');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_address');
		expect(getBalancesMock).not.toHaveBeenCalled();
	});

	it('400s on an unsupported chain', async () => {
		const { res, body } = await call(`/api/crypto/wallet?address=${WALLET}&chain=dogechain`);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('unsupported_chain');
		expect(body.supported).toContain('solana');
	});
});

describe('GET /api/crypto/wallet — balance parsing + USD valuation', () => {
	it('maps native + tokens and prices them, unpriced tokens report usd:null', async () => {
		getBalancesMock.mockResolvedValueOnce({
			chain: 'solana',
			address: WALLET,
			native: { symbol: 'SOL', name: 'Solana', amount: 2.5, price: 150, usd: 375 },
			tokens: [
				{ mint: THREE, symbol: 'THREE', name: 'three.ws', decimals: 6, amount: 1000, price: 0.0016, usd: 1.6, logo: 'https://img/three.png' },
				// Unpriced: Jupiter/pump.fun couldn't route it → price 0. Still listed.
				{ mint: SYNTH, symbol: 'SYNTH', name: 'Synthetic', decimals: 6, amount: 500, price: 0, usd: 0, logo: null },
			],
		});

		const { res, body } = await call(`/api/crypto/wallet?address=${WALLET}&chain=solana`);
		expect(res.statusCode).toBe(200);
		expect(body.address).toBe(WALLET);
		expect(body.chain).toBe('solana');

		expect(body.native).toEqual({ symbol: 'SOL', amount: 2.5, usd: 375 });

		expect(body.tokens).toHaveLength(2);
		const three = body.tokens.find((t) => t.mint === THREE);
		expect(three).toMatchObject({ mint: THREE, symbol: 'THREE', amount: 1000, usd: 1.6 });

		const synth = body.tokens.find((t) => t.mint === SYNTH);
		expect(synth.usd).toBeNull(); // unpriced → null, never a fake 0
		expect(synth.amount).toBe(500); // ...but still listed with its amount

		// totalUsd = native 375 + THREE 1.6 (+ unpriced 0)
		expect(body.totalUsd).toBe(376.6);
		expect(body.tokenCount).toBe(2);
		expect(body.truncated).toBe(false);
		expect(typeof body.ts).toBe('string');
	});

	it('keyless path (no Helius key) reports solana-rpc + jupiter-lite as sources', async () => {
		heliusHealthMock.mockReturnValue({ configured: false, available: true, degraded: false });
		getBalancesMock.mockResolvedValueOnce({
			chain: 'solana', address: WALLET,
			native: { symbol: 'SOL', amount: 1, price: 150, usd: 150 }, tokens: [],
		});
		const { body } = await call(`/api/crypto/wallet?address=${WALLET}`);
		expect(body.sources).toEqual(['solana-rpc', 'jupiter-lite']);
	});

	it('uses helius-das as the source when a key is configured and healthy', async () => {
		heliusHealthMock.mockReturnValue({ configured: true, available: true, degraded: false });
		getBalancesMock.mockResolvedValueOnce({
			chain: 'solana', address: WALLET,
			native: { symbol: 'SOL', amount: 1, price: 150, usd: 150 }, tokens: [],
		});
		const { body } = await call(`/api/crypto/wallet?address=${WALLET}`);
		expect(body.sources).toEqual(['helius-das', 'jupiter-lite']);
	});

	it('empty wallet → 200 with zeros and an empty token array', async () => {
		getBalancesMock.mockResolvedValueOnce({
			chain: 'solana', address: WALLET,
			native: { symbol: 'SOL', amount: 0, price: 150, usd: 0 }, tokens: [],
		});
		const { res, body } = await call(`/api/crypto/wallet?address=${WALLET}`);
		expect(res.statusCode).toBe(200);
		expect(body.native).toEqual({ symbol: 'SOL', amount: 0, usd: 0 });
		expect(body.tokens).toEqual([]);
		expect(body.totalUsd).toBe(0);
		expect(body.tokenCount).toBe(0);
		expect(body.truncated).toBe(false);
	});

	it('caps the token list at 200 and flags truncated, keeping tokenCount honest', async () => {
		const many = Array.from({ length: 250 }, (_, i) => ({
			mint: `${SYNTH.slice(0, 40)}${String(i).padStart(2, '0')}`,
			symbol: `T${i}`, name: `Token ${i}`, decimals: 6,
			amount: 250 - i, price: 1, usd: 250 - i, logo: null,
		}));
		getBalancesMock.mockResolvedValueOnce({
			chain: 'solana', address: WALLET,
			native: { symbol: 'SOL', amount: 0, price: 150, usd: 0 }, tokens: many,
		});
		const { body } = await call(`/api/crypto/wallet?address=${WALLET}`);
		expect(body.tokens).toHaveLength(200);
		expect(body.truncated).toBe(true);
		expect(body.tokenCount).toBe(250); // full count preserved even when the list is capped
	});

	it('passes a stale flag through when the balance layer served last-known-good', async () => {
		getBalancesMock.mockResolvedValueOnce({
			chain: 'solana', address: WALLET, stale: true,
			native: { symbol: 'SOL', amount: 1, price: 150, usd: 150 }, tokens: [],
		});
		const { body } = await call(`/api/crypto/wallet?address=${WALLET}`);
		expect(body.stale).toBe(true);
	});
});

describe('GET /api/crypto/wallet — error states', () => {
	it('429s when the rate limiter rejects', async () => {
		limits.cryptoDataIp.mockResolvedValueOnce({ success: false });
		const { res, body } = await call(`/api/crypto/wallet?address=${WALLET}`);
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});

	it('503 not_configured for an EVM chain with no provider key', async () => {
		getBalancesMock.mockRejectedValueOnce(Object.assign(new Error('not_configured: ALCHEMY_API_KEY'), { code: 'not_configured' }));
		const { res, body } = await call('/api/crypto/wallet?address=0x1111111111111111111111111111111111111111&chain=ethereum');
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('not_configured');
	});

	it('503 retryable when every upstream RPC path fails', async () => {
		getBalancesMock.mockRejectedValueOnce(Object.assign(new Error('upstream 502'), { status: 502 }));
		const { res, body } = await call(`/api/crypto/wallet?address=${WALLET}`);
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('upstream_unavailable');
		expect(res.getHeader('retry-after')).toBe('15');
	});
});

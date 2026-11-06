// Replay guard for hand-rolled x402 endpoints (MCP servers + launchpad/invoke).
//
// The paidEndpoint() wrapper closes the verify→deliver→settle re-delivery window
// with a proof-hash reservation; the MCP servers and launchpad/invoke hand-roll
// that dance, so they share reservePaymentProof() from payment-identifier-server.
//
// Double-CHARGE is already prevented downstream (on-chain EIP-3009 nonce / Solana
// blockhash + the deterministic facilitator Idempotency-Key). These tests pin the
// remaining property: a captured/retried X-PAYMENT can't acquire the lock twice
// in the pre-settlement window, so it can't re-run the (often expensive) work for
// free — while a transient failure (release on any finish) stays retryable.
//
// Exercises the helper directly against the in-process Map fallback in
// idempotency-cache.js (no Redis in CI), matching x402-payment-identifier.test.js.

import { describe, it, expect, beforeEach } from 'vitest';

import * as cache from '../../api/_lib/x402/idempotency-cache.js';
import {
	reservePaymentProof,
	hashPaymentProof,
} from '../../api/_lib/x402/payment-identifier-server.js';

// A realistic base64 X-PAYMENT header — the helper hashes the exact header bytes.
function header(nonce) {
	return Buffer.from(
		JSON.stringify({
			x402Version: 2,
			scheme: 'exact',
			network: 'eip155:8453',
			payload: { authorization: { value: '1000', nonce } },
		}),
		'utf8',
	).toString('base64');
}

beforeEach(() => {
	cache._resetMemoryStore();
});

describe('reservePaymentProof', () => {
	it('no header → ok with a no-op release (free/bearer calls are never blocked)', async () => {
		const g = await reservePaymentProof('/api/mcp', undefined);
		expect(g.ok).toBe(true);
		await expect(g.release()).resolves.toBeUndefined();
	});

	it('first reservation wins; a concurrent duplicate of the same proof is blocked', async () => {
		const h = header('0xaaa');
		const first = await reservePaymentProof('/api/mcp', h);
		expect(first.ok).toBe(true);

		const dup = await reservePaymentProof('/api/mcp', h);
		expect(dup.ok).toBe(false);

		await first.release();
	});

	it('release frees the slot so the same payment can be retried (transient-failure path)', async () => {
		const h = header('0xretry');
		const first = await reservePaymentProof('/api/mcp', h);
		expect(first.ok).toBe(true);
		await first.release();

		const retry = await reservePaymentProof('/api/mcp', h);
		expect(retry.ok).toBe(true);
		await retry.release();
	});

	it('distinct payments do not collide', async () => {
		const a = await reservePaymentProof('/api/mcp', header('0x1'));
		const b = await reservePaymentProof('/api/mcp', header('0x2'));
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
	});

	it('same proof under different routes does not collide (route-namespaced key)', async () => {
		const h = header('0xroute');
		const a = await reservePaymentProof('/api/mcp', h);
		const b = await reservePaymentProof('/api/mcp-3d', h);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
	});

	it('release is idempotent — a double release never re-deletes another claim', async () => {
		const h = header('0xidem');
		const g = await reservePaymentProof('/api/mcp', h);
		expect(g.ok).toBe(true);
		await g.release();
		await g.release(); // no-op, must not throw or free a future claim

		// A new claim taken after the double-release stays held.
		const next = await reservePaymentProof('/api/mcp', h);
		expect(next.ok).toBe(true);
		const dup = await reservePaymentProof('/api/mcp', h);
		expect(dup.ok).toBe(false);
		await next.release();
	});

	it('the reservation key is bound to the exact signed payment bytes', () => {
		const h = header('0xbind');
		expect(hashPaymentProof(h)).toBe(hashPaymentProof(h));
		expect(hashPaymentProof(h)).not.toBe(hashPaymentProof(header('0xother')));
		expect(hashPaymentProof(undefined)).toBeNull();
	});
});

// Tests for the AP2 Cart Mandate: the signed, tamper-evident per-transaction
// approval bound to an Intent Mandate. Covers issue/verify round-trip, hash
// tamper detection, intent binding, payment matching, and TTL bounds.

import { describe, expect, it } from 'vitest';
import * as jose from 'jose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.A2A_MANDATE_SECRET = 'test-a2a-mandate-secret';

import { env } from '../api/_lib/env.js';
import {
	assertCartMatchesPayment,
	CART_MANDATE_TYPE,
	issueCartMandate,
	MAX_CART_TTL_SECONDS,
	verifyCartMandate,
} from '../api/_lib/a2a/cart-mandate.js';

// A decoded Intent Mandate, the shape verifyIntentMandate returns.
const intentMandate = {
	mandateId: 'intent-123',
	ownerUserId: 'user-1',
	subjectAgentId: 'agent-1',
	currency: 'USDC',
};

const baseCart = {
	resource: 'https://peer.example/api/agents/a2a',
	amountAtomics: '500000', // $0.50
	currency: 'USDC',
	network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	taskId: 'task-9',
	items: [{ name: 'crypto intel report', amountAtomics: '500000' }],
};

describe('Cart Mandate', () => {
	it('issues and verifies a cart mandate bound to its intent mandate', async () => {
		const { jws, cartMandate } = await issueCartMandate({ intentMandate, cart: baseCart });
		expect(typeof jws).toBe('string');

		const verified = await verifyCartMandate(jws);
		expect(verified.cartMandateId).toBe(cartMandate.cartMandateId);
		expect(verified.intentMandateId).toBe('intent-123');
		expect(verified.ownerUserId).toBe('user-1');
		expect(verified.subjectAgentId).toBe('agent-1');
		expect(verified.amountAtomics).toBe('500000');
		expect(verified.resource).toBe(baseCart.resource);
		expect(verified.network).toBe(baseCart.network);
		expect(verified.taskId).toBe('task-9');
		expect(verified.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('rejects a tampered/garbage token', async () => {
		await expect(verifyCartMandate('not.a.jwt')).rejects.toMatchObject({ code: 'invalid_cart_mandate' });
		const { jws } = await issueCartMandate({ intentMandate, cart: baseCart });
		await expect(verifyCartMandate(jws + 'x')).rejects.toMatchObject({ code: 'invalid_cart_mandate' });
	});

	it('detects a body whose hash does not match (recomputed on verify)', async () => {
		// Forge a validly-signed token whose cart amount disagrees with its hash —
		// the recompute guard must catch it even though the signature is valid.
		const secret = new TextEncoder().encode(process.env.A2A_MANDATE_SECRET);
		const now = Math.floor(Date.now() / 1000);
		const forged = await new jose.SignJWT({
			typ: CART_MANDATE_TYPE,
			ver: 1,
			owner: 'user-1',
			intent: 'intent-123',
			c: {
				resource: baseCart.resource,
				amountAtomics: '999999999', // lies — does not match the hash below
				currency: 'USDC',
				network: baseCart.network,
				taskId: 'task-9',
				items: [],
				hash: 'deadbeef'.repeat(8),
			},
		})
			.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
			.setSubject('agent-1')
			.setIssuer(env.APP_ORIGIN)
			.setIssuedAt(now)
			.setExpirationTime(now + 300)
			.setJti('forged-1')
			.sign(secret);

		await expect(verifyCartMandate(forged)).rejects.toMatchObject({ code: 'cart_hash_mismatch' });
	});

	it('enforces the expected intent mandate binding', async () => {
		const { jws } = await issueCartMandate({ intentMandate, cart: baseCart });
		await expect(
			verifyCartMandate(jws, { expectedIntentMandateId: 'some-other-intent' }),
		).rejects.toMatchObject({ code: 'intent_mismatch' });
		// Correct intent id passes.
		await expect(verifyCartMandate(jws, { expectedIntentMandateId: 'intent-123' })).resolves.toBeTruthy();
	});

	it('rejects an expired cart mandate', async () => {
		const secret = new TextEncoder().encode(process.env.A2A_MANDATE_SECRET);
		const past = Math.floor(Date.now() / 1000) - 3600;
		const expired = await new jose.SignJWT({ typ: CART_MANDATE_TYPE, ver: 1, owner: 'u', intent: 'i', c: {} })
			.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
			.setSubject('agent-1')
			.setIssuer(env.APP_ORIGIN)
			.setIssuedAt(past - 60)
			.setExpirationTime(past)
			.setJti('exp-1')
			.sign(secret);
		await expect(verifyCartMandate(expired)).rejects.toMatchObject({ code: 'cart_mandate_expired' });
	});

	it('rejects an out-of-bounds TTL and a malformed cart at issuance', async () => {
		await expect(
			issueCartMandate({ intentMandate, cart: baseCart, ttlSec: MAX_CART_TTL_SECONDS + 1 }),
		).rejects.toMatchObject({ code: 'invalid_ttl' });
		await expect(
			issueCartMandate({ intentMandate, cart: { ...baseCart, resource: 'ftp://nope' } }),
		).rejects.toMatchObject({ code: 'invalid_cart' });
		await expect(
			issueCartMandate({ intentMandate, cart: { ...baseCart, amountAtomics: '0' } }),
		).rejects.toMatchObject({ code: 'invalid_amount' });
	});
});

describe('assertCartMatchesPayment', () => {
	it('passes when the payment matches the cart exactly', async () => {
		const { cartMandate } = await issueCartMandate({ intentMandate, cart: baseCart });
		expect(() =>
			assertCartMatchesPayment({
				cartMandate,
				amountAtomics: '500000',
				network: baseCart.network,
				resource: baseCart.resource,
				currency: 'USDC',
			}),
		).not.toThrow();
	});

	it('rejects a payment that differs from the cart', async () => {
		const { cartMandate } = await issueCartMandate({ intentMandate, cart: baseCart });
		const codeOf = (fn) => {
			try {
				fn();
			} catch (e) {
				return e.code;
			}
			return null;
		};
		expect(codeOf(() => assertCartMatchesPayment({ cartMandate, amountAtomics: '600000' }))).toBe(
			'cart_amount_mismatch',
		);
		expect(
			codeOf(() =>
				assertCartMatchesPayment({ cartMandate, amountAtomics: '500000', network: 'eip155:1' }),
			),
		).toBe('cart_network_mismatch');
		expect(
			codeOf(() =>
				assertCartMatchesPayment({
					cartMandate,
					amountAtomics: '500000',
					resource: 'https://evil.example/x',
				}),
			),
		).toBe('cart_resource_mismatch');
	});
});

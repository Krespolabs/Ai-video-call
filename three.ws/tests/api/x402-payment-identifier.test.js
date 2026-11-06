// USE-15 tests: payment-identifier idempotency.
//
// Exercises the helpers in api/_lib/x402/ directly so they don't depend on
// Redis. The in-process Map fallback in idempotency-cache.js is what the
// test runner uses (no UPSTASH_REDIS_REST_URL set in CI).
//
// Coverage:
//   • Cache get/set with TTL eviction (in-memory fallback).
//   • Cache hit replays the stored response.
//   • Same id + different payload → conflict signal (server emits 409).
//   • required=true rejects requests with no payment-identifier.
//   • The 402 challenge from paidEndpoint declares the extension.
//   • Buyer hook appends an id when the server advertises support.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import * as cache from '../../api/_lib/x402/idempotency-cache.js';
import {
	checkCache,
	enforceRequired,
	extractIdFromHeader,
	hashRequestPayload,
	paymentIdentifierExtension,
	storeResponse,
	writeCachedResponse,
	writeConflict,
	PAYMENT_IDENTIFIER,
} from '../../api/_lib/x402/payment-identifier-server.js';
import { installIdempotency } from '../../api/_lib/x402/payment-identifier-client.js';

const ROUTE = '/api/x402/test-route';
const VALID_ID = 'pay_0123456789abcdef0123456789abcdef';
const OTHER_ID = 'pay_fedcba9876543210fedcba9876543210';

function encodeHeader(payload) {
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function makeRes() {
	const res = {
		statusCode: 200,
		headers: {},
		_body: null,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(body) {
			this._body = body;
		},
	};
	return res;
}

beforeEach(() => {
	cache._resetMemoryStore();
});

describe('idempotency-cache (in-memory fallback)', () => {
	it('returns null for missing keys', async () => {
		const got = await cache.get(ROUTE, VALID_ID);
		expect(got).toBeNull();
	});

	it('round-trips a response entry within TTL', async () => {
		const entry = { status: 200, body: '{"ok":true}', payloadHash: 'h1' };
		await cache.set(ROUTE, VALID_ID, entry, 60);
		const got = await cache.get(ROUTE, VALID_ID);
		expect(got).toMatchObject(entry);
	});

	it('expires entries past the TTL', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-05-21T00:00:00Z'));
			await cache.set(ROUTE, VALID_ID, { body: 'x', payloadHash: 'h1' }, 1);
			expect(await cache.get(ROUTE, VALID_ID)).toBeTruthy();
			vi.setSystemTime(new Date('2026-05-21T00:00:02Z'));
			expect(await cache.get(ROUTE, VALID_ID)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('hashes the request URL stably', () => {
		const a = hashRequestPayload({ method: 'GET', url: '/api/x402/dance-tip?dancer=1' });
		const b = hashRequestPayload({ method: 'GET', url: '/api/x402/dance-tip?dancer=1' });
		const c = hashRequestPayload({ method: 'GET', url: '/api/x402/dance-tip?dancer=2' });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('checkCache + storeResponse', () => {
	it('reports miss when no entry exists', async () => {
		const result = await checkCache({ route: ROUTE, paymentId: VALID_ID, payloadHash: 'h1' });
		expect(result.kind).toBe('miss');
	});

	it('reports miss when no paymentId is provided', async () => {
		const result = await checkCache({ route: ROUTE, paymentId: null, payloadHash: 'h1' });
		expect(result.kind).toBe('miss');
	});

	it('reports hit when the stored payloadHash matches', async () => {
		await storeResponse({
			route: ROUTE,
			paymentId: VALID_ID,
			payloadHash: 'h1',
			status: 200,
			body: '{"ok":true}',
			contentType: 'application/json; charset=utf-8',
			paymentResponseHeader: 'cmVwbGF5',
			ttlSeconds: 60,
		});
		const result = await checkCache({ route: ROUTE, paymentId: VALID_ID, payloadHash: 'h1' });
		expect(result.kind).toBe('hit');
		expect(result.entry.body).toBe('{"ok":true}');
		expect(result.entry.paymentResponseHeader).toBe('cmVwbGF5');
	});

	it('reports conflict when payloadHash differs from the stored one', async () => {
		await storeResponse({
			route: ROUTE,
			paymentId: VALID_ID,
			payloadHash: 'h1',
			status: 200,
			body: 'a',
			contentType: 'application/json',
			paymentResponseHeader: '',
			ttlSeconds: 60,
		});
		const result = await checkCache({
			route: ROUTE,
			paymentId: VALID_ID,
			payloadHash: 'h2',
		});
		expect(result.kind).toBe('conflict');
		expect(result.existingHash).toBe('h1');
		expect(result.attemptedHash).toBe('h2');
	});
});

describe('extractIdFromHeader', () => {
	it('returns null for missing header', () => {
		expect(extractIdFromHeader('')).toBeNull();
		expect(extractIdFromHeader(null)).toBeNull();
	});

	it('returns null for malformed base64/json', () => {
		expect(extractIdFromHeader('not-base64-!!!!')).toBeNull();
	});

	it('extracts a valid id from a base64-encoded payment payload', () => {
		const header = encodeHeader({
			x402Version: 2,
			extensions: {
				[PAYMENT_IDENTIFIER]: {
					info: { required: false, id: VALID_ID },
				},
			},
		});
		expect(extractIdFromHeader(header)).toBe(VALID_ID);
	});

	it('returns null when the id fails format validation', () => {
		const header = encodeHeader({
			extensions: {
				[PAYMENT_IDENTIFIER]: { info: { required: false, id: 'too-short' } },
			},
		});
		expect(extractIdFromHeader(header)).toBeNull();
	});
});

describe('enforceRequired', () => {
	it('is a no-op when required=false', () => {
		expect(() => enforceRequired({ paymentHeader: '', required: false })).not.toThrow();
	});

	it('throws a 400 X402Error when required=true and no id is present', () => {
		const header = encodeHeader({ x402Version: 2 });
		let caught;
		try {
			enforceRequired({ paymentHeader: header, required: true });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeTruthy();
		expect(caught.status).toBe(400);
		expect(caught.code).toBe('payment_identifier_required');
	});

	it('passes when required=true and an id is provided', () => {
		const header = encodeHeader({
			extensions: {
				[PAYMENT_IDENTIFIER]: { info: { required: true, id: VALID_ID } },
			},
		});
		expect(() => enforceRequired({ paymentHeader: header, required: true })).not.toThrow();
	});
});

describe('paymentIdentifierExtension declaration', () => {
	it('builds a v2-shaped extension with `required` and the JSON schema', () => {
		const ext = paymentIdentifierExtension(true);
		expect(ext.info.required).toBe(true);
		expect(ext.schema).toBeDefined();
		expect(ext.schema.type).toBe('object');
		expect(ext.schema.properties.id).toMatchObject({ type: 'string' });
	});
});

describe('writeCachedResponse + writeConflict', () => {
	it('writeCachedResponse mirrors stored headers + body and tags as replay', () => {
		const res = makeRes();
		writeCachedResponse(res, {
			status: 200,
			body: '{"hello":"world"}',
			contentType: 'application/json; charset=utf-8',
			paymentResponseHeader: 'cmVwbGF5',
		});
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
		expect(res.headers['x-x402-idempotent']).toBe('replay');
		expect(res.headers['x-payment-response']).toBe('cmVwbGF5');
		expect(res._body).toBe('{"hello":"world"}');
	});

	it('writeConflict emits 409 with the conflicting hashes', () => {
		const res = makeRes();
		writeConflict(res, { route: ROUTE, attemptedHash: 'h2', existingHash: 'h1' });
		expect(res.statusCode).toBe(409);
		expect(res.headers['x-x402-idempotent']).toBe('conflict');
		const body = JSON.parse(res._body);
		expect(body.error).toBe('payment_identifier_conflict');
		expect(body.attemptedPayloadHash).toBe('h2');
		expect(body.existingPayloadHash).toBe('h1');
	});
});

describe('installIdempotency client hook', () => {
	it('appends the configured id only when the server declared the extension', async () => {
		const captured = [];
		const fakeClient = {
			onBeforePaymentCreation(fn) {
				captured.push(fn);
				return this;
			},
		};
		installIdempotency(fakeClient, { paymentId: VALID_ID });
		expect(captured).toHaveLength(1);

		// Server does NOT declare the extension → hook should not mutate.
		const noDeclare = { paymentRequired: { extensions: { other: {} } } };
		await captured[0](noDeclare);
		expect(noDeclare.paymentRequired.extensions[PAYMENT_IDENTIFIER]).toBeUndefined();

		// Server DOES declare it → the hook appends our id.
		const declared = {
			paymentRequired: {
				extensions: {
					[PAYMENT_IDENTIFIER]: paymentIdentifierExtension(false),
				},
			},
		};
		await captured[0](declared);
		expect(declared.paymentRequired.extensions[PAYMENT_IDENTIFIER].info.id).toBe(VALID_ID);
	});

	it('generates a fresh id when no paymentId/getPaymentId is provided', async () => {
		let hook;
		const fakeClient = { onBeforePaymentCreation: (fn) => { hook = fn; } };
		installIdempotency(fakeClient);
		const ctx = {
			paymentRequired: {
				extensions: { [PAYMENT_IDENTIFIER]: paymentIdentifierExtension(false) },
			},
		};
		await hook(ctx);
		const id = ctx.paymentRequired.extensions[PAYMENT_IDENTIFIER].info.id;
		expect(typeof id).toBe('string');
		expect(id.length).toBeGreaterThanOrEqual(16);
	});

	it('throws when the client does not expose .onBeforePaymentCreation', () => {
		expect(() => installIdempotency({})).toThrow(/onBeforePaymentCreation/);
	});
});

describe('reused-id miss-after-different-route', () => {
	it('cache keys are scoped per-route so the same id can be reused across routes', async () => {
		await storeResponse({
			route: '/api/x402/a',
			paymentId: VALID_ID,
			payloadHash: 'h1',
			status: 200,
			body: 'a',
			contentType: 'application/json',
			paymentResponseHeader: '',
			ttlSeconds: 60,
		});
		const otherRoute = await checkCache({
			route: '/api/x402/b',
			paymentId: VALID_ID,
			payloadHash: 'h1',
		});
		expect(otherRoute.kind).toBe('miss');
	});

	it('different ids on the same route do not collide', async () => {
		await storeResponse({
			route: ROUTE,
			paymentId: VALID_ID,
			payloadHash: 'h1',
			status: 200,
			body: 'a',
			contentType: 'application/json',
			paymentResponseHeader: '',
			ttlSeconds: 60,
		});
		const result = await checkCache({ route: ROUTE, paymentId: OTHER_ID, payloadHash: 'h1' });
		expect(result.kind).toBe('miss');
	});
});

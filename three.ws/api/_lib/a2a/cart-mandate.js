// Cart Mandate — AP2's per-transaction approval, the companion to the Intent
// Mandate in api/_lib/a2a/mandate.js.
//
// Where an Intent Mandate is a STANDING authorization ("agent X may spend up to
// $N on my behalf, under these caps"), a Cart Mandate is a SPECIFIC, now-or-never
// approval of one exact transaction: this resource, this amount, this currency,
// on this network, for these line items. It is signed at settlement time and
// cryptographically bound to the Intent Mandate it draws on (by the intent's
// jti) and to the cart contents (by a SHA-256 hash), so it is a non-repudiable
// record that says: "the holder of intent mandate <id>, owned by <user>,
// authorized paying <resource> exactly <amount> <currency> for <this cart>."
//
// This mirrors Google's Agent Payments Protocol (AP2), where the Cart Mandate is
// the artifact a merchant retains as proof of what was agreed before settlement.
// In three.ws it composes with x402: the Intent Mandate gates whether a payment
// is allowed (api/agents/a2a-call.js), the Cart Mandate records exactly what was
// paid, and x402 performs the settlement.
//
// Signed as a compact JWS (HS256) with the same A2A_MANDATE_SECRET the Intent
// Mandate uses — the platform is the mandate authority. Verification is fully
// offline and recomputes the cart hash, so a presented Cart Mandate whose body
// was altered fails the same way a bad signature does.

import * as jose from 'jose';

import { env } from '../env.js';
import { MandateError } from './mandate.js';

export const CART_MANDATE_TYPE = 'a2a-cart-mandate';
export const CART_MANDATE_VERSION = 1;

// A specific cart is a now-or-never approval — short-lived by design. 5 min
// default covers a quote→settle round-trip; 1 hour is the hard ceiling.
export const DEFAULT_CART_TTL_SECONDS = 5 * 60;
export const MAX_CART_TTL_SECONDS = 60 * 60;

function secretKey() {
	const secret = env.A2A_MANDATE_SECRET;
	if (!secret) {
		throw new MandateError(
			'mandate_signing_unconfigured',
			'A2A_MANDATE_SECRET (or JWT_SECRET) must be set to issue or verify cart mandates',
			500,
		);
	}
	return new TextEncoder().encode(secret);
}

function toPositiveAtomics(value, field) {
	let bi;
	try {
		bi = typeof value === 'bigint' ? value : BigInt(String(value).trim());
	} catch {
		throw new MandateError('invalid_amount', `${field} must be an integer atomic amount`);
	}
	if (bi <= 0n) throw new MandateError('invalid_amount', `${field} must be greater than zero`);
	return bi;
}

// Normalize a cart into a canonical, deterministically-ordered object so its
// hash is stable regardless of input key order or extra fields. Line items are
// reduced to {name, amountAtomics} and sorted, so the same cart always hashes the
// same on both the issuing and verifying side.
function canonicalCart(cart) {
	const items = Array.isArray(cart.items)
		? cart.items
				.map((it) => ({
					name: String(it?.name ?? ''),
					amountAtomics: it?.amountAtomics != null ? String(it.amountAtomics) : '',
				}))
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		: [];
	// Fixed key order — JSON.stringify preserves insertion order for string keys.
	return JSON.stringify({
		amountAtomics: String(cart.amountAtomics),
		currency: String(cart.currency || ''),
		items,
		network: String(cart.network || ''),
		resource: String(cart.resource || ''),
		taskId: String(cart.taskId || ''),
	});
}

// SHA-256 of the canonical cart, hex-encoded. Web Crypto (subtle) keeps this
// runtime-agnostic across Node and the edge runtime.
async function cartHash(cart) {
	const data = new TextEncoder().encode(canonicalCart(cart));
	const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function validateCart(cart) {
	if (!cart || typeof cart !== 'object') {
		throw new MandateError('invalid_cart', 'cart is required');
	}
	if (!cart.resource || !/^https?:\/\//i.test(String(cart.resource))) {
		throw new MandateError('invalid_cart', 'cart.resource must be an http(s) URL');
	}
	toPositiveAtomics(cart.amountAtomics, 'cart.amountAtomics');
	if (!cart.network) throw new MandateError('invalid_cart', 'cart.network is required');
	if (cart.items != null && !Array.isArray(cart.items)) {
		throw new MandateError('invalid_cart', 'cart.items must be an array');
	}
}

function decodeFromClaims(claims, registered) {
	const c = claims.c || {};
	return {
		cartMandateId: registered.jti,
		intentMandateId: claims.intent,
		ownerUserId: claims.owner,
		subjectAgentId: registered.sub,
		resource: c.resource,
		amountAtomics: c.amountAtomics,
		currency: c.currency,
		network: c.network,
		items: Array.isArray(c.items) ? c.items : [],
		taskId: c.taskId || '',
		hash: c.hash,
		issuedAt: registered.iat,
		expiresAt: registered.exp,
	};
}

/**
 * Issue (sign) a Cart Mandate bound to a verified Intent Mandate.
 *
 * @param {object} opts
 * @param {object} opts.intentMandate  Decoded Intent Mandate (from verifyIntentMandate).
 * @param {object} opts.cart           { resource, amountAtomics, currency, network, items?, taskId? }
 * @param {number} [opts.ttlSec]       Lifetime (1..MAX_CART_TTL_SECONDS).
 * @returns {Promise<{ jws: string, cartMandate: object }>}
 */
export async function issueCartMandate({ intentMandate, cart, ttlSec = DEFAULT_CART_TTL_SECONDS }) {
	if (!intentMandate?.mandateId || !intentMandate.ownerUserId || !intentMandate.subjectAgentId) {
		throw new MandateError('invalid_mandate', 'a verified intent mandate is required', 400);
	}
	validateCart(cart);

	const ttl = Number(ttlSec);
	if (!Number.isFinite(ttl) || ttl < 1 || ttl > MAX_CART_TTL_SECONDS) {
		throw new MandateError('invalid_ttl', `ttlSec must be between 1 and ${MAX_CART_TTL_SECONDS}`);
	}

	const normalizedCart = {
		resource: String(cart.resource),
		amountAtomics: String(toPositiveAtomics(cart.amountAtomics, 'cart.amountAtomics')),
		currency: String(cart.currency || intentMandate.currency || ''),
		network: String(cart.network),
		taskId: String(cart.taskId || ''),
		items: Array.isArray(cart.items) ? cart.items : [],
	};
	const hash = await cartHash(normalizedCart);

	const nowSec = Math.floor(Date.now() / 1000);
	const mandateId = globalThis.crypto.randomUUID();
	const claims = {
		typ: CART_MANDATE_TYPE,
		ver: CART_MANDATE_VERSION,
		owner: intentMandate.ownerUserId,
		intent: intentMandate.mandateId,
		c: { ...normalizedCart, hash },
	};

	const jws = await new jose.SignJWT(claims)
		.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
		.setSubject(intentMandate.subjectAgentId)
		.setIssuer(env.APP_ORIGIN)
		.setIssuedAt(nowSec)
		.setExpirationTime(nowSec + ttl)
		.setJti(mandateId)
		.sign(secretKey());

	return {
		jws,
		cartMandate: decodeFromClaims(claims, {
			jti: mandateId,
			sub: intentMandate.subjectAgentId,
			iat: nowSec,
			exp: nowSec + ttl,
		}),
	};
}

/**
 * Verify a Cart Mandate's signature, expiry, type, and — critically — that its
 * body still hashes to the signed hash (tamper detection). Optionally assert it
 * was issued under a specific Intent Mandate.
 *
 * @param {string} jws
 * @param {{ expectedIntentMandateId?: string }} [opts]
 * @returns {Promise<object>} decoded cart mandate
 */
export async function verifyCartMandate(jws, { expectedIntentMandateId } = {}) {
	if (!jws || typeof jws !== 'string') {
		throw new MandateError('invalid_cart_mandate', 'cart mandate (compact JWS) is required', 400);
	}
	let payload;
	try {
		({ payload } = await jose.jwtVerify(jws, secretKey(), {
			issuer: env.APP_ORIGIN,
			algorithms: ['HS256'],
		}));
	} catch (err) {
		const expired = err?.code === 'ERR_JWT_EXPIRED';
		throw new MandateError(
			expired ? 'cart_mandate_expired' : 'invalid_cart_mandate',
			expired ? 'cart mandate has expired' : `cart mandate verification failed: ${err.message}`,
			401,
		);
	}
	if (payload.typ !== CART_MANDATE_TYPE) {
		throw new MandateError('invalid_cart_mandate', 'not a cart mandate', 401);
	}

	const mandate = decodeFromClaims(payload, {
		jti: payload.jti,
		sub: payload.sub,
		iat: payload.iat,
		exp: payload.exp,
	});

	// Recompute the hash from the signed body: a valid signature over a tampered
	// `c` (impossible with a shared secret, but verify defensively) is rejected.
	const recomputed = await cartHash({
		resource: mandate.resource,
		amountAtomics: mandate.amountAtomics,
		currency: mandate.currency,
		network: mandate.network,
		taskId: mandate.taskId,
		items: mandate.items,
	});
	if (recomputed !== mandate.hash) {
		throw new MandateError('cart_hash_mismatch', 'cart mandate body does not match its hash', 401);
	}

	if (expectedIntentMandateId && mandate.intentMandateId !== expectedIntentMandateId) {
		throw new MandateError(
			'intent_mismatch',
			'cart mandate was not issued under the expected intent mandate',
			401,
		);
	}

	return mandate;
}

/**
 * Assert a Cart Mandate authorizes exactly the payment about to settle. Used as a
 * defensive check before forwarding settlement, and by any third party verifying
 * that a presented cart matches what they were asked to fulfill.
 *
 * @param {object} opts
 * @param {object} opts.cartMandate  Decoded, verified cart mandate.
 * @param {string|number|bigint} opts.amountAtomics
 * @param {string} opts.network
 * @param {string} opts.resource
 * @param {string} [opts.currency]
 */
export function assertCartMatchesPayment({ cartMandate, amountAtomics, network, resource, currency }) {
	if (!cartMandate || typeof cartMandate !== 'object') {
		throw new MandateError('invalid_cart_mandate', 'cart mandate is required', 400);
	}
	if (BigInt(cartMandate.amountAtomics) !== toPositiveAtomics(amountAtomics, 'amount')) {
		throw new MandateError('cart_amount_mismatch', 'payment amount does not match the cart', 402);
	}
	if (network && cartMandate.network && network !== cartMandate.network) {
		throw new MandateError('cart_network_mismatch', 'payment network does not match the cart', 402);
	}
	if (resource && cartMandate.resource && resource !== cartMandate.resource) {
		throw new MandateError('cart_resource_mismatch', 'payment resource does not match the cart', 402);
	}
	if (currency && cartMandate.currency && currency !== cartMandate.currency) {
		throw new MandateError('cart_currency_mismatch', 'payment currency does not match the cart', 402);
	}
}

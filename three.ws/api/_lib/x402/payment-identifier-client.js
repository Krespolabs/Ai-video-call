// Client-side helpers for the x402 payment-identifier extension (USE-15).
//
// `installIdempotency(client, options)` registers an `onBeforePaymentCreation`
// hook on a `x402Client` (or any object that exposes `.onBeforePaymentCreation`)
// so every paid request opts into the server's idempotency cache.
//
// Two modes:
//   * `paymentId: <string>` — pin a stable id across retries. Use this when
//     the caller code knows the logical request (e.g. an order id, a task id,
//     or a sessionStorage `requestId` carried across browser reloads).
//   * `getPaymentId: ({ url, method }) => string | Promise<string>` — derive
//     the id from request context. Falls back to a fresh generated id when
//     the resolver returns null/undefined.
//
// When neither option is set, a fresh id is generated per request — still
// useful because (a) it lets the server resume in-flight retries triggered
// inside @x402/fetch's own retry loop, and (b) the server's 409 conflict
// path becomes a real signal rather than dead code.

import {
	PAYMENT_IDENTIFIER,
	appendPaymentIdentifierToExtensions,
	generatePaymentId,
	isValidPaymentId,
} from '@x402/extensions/payment-identifier';

export { PAYMENT_IDENTIFIER, generatePaymentId, isValidPaymentId };

// Register a payment-identifier hook on an x402Client.
//
// Returns the same `client` for chaining. The hook is a no-op when the
// server doesn't advertise the extension — `appendPaymentIdentifierToExtensions`
// already checks for the declaration before mutating `extensions`.
export function installIdempotency(client, options = {}) {
	if (!client || typeof client.onBeforePaymentCreation !== 'function') {
		throw new TypeError(
			'installIdempotency: client must expose .onBeforePaymentCreation (x402Client)',
		);
	}
	const resolveId = buildResolver(options);
	client.onBeforePaymentCreation(async (context) => {
		const extensions = context?.paymentRequired?.extensions;
		if (!extensions) return;
		// Skip when the server didn't declare support — keeps payloads minimal
		// against legacy endpoints. appendPaymentIdentifierToExtensions also
		// guards on this, but resolving the id can be expensive (sessionStorage
		// read, fetch from an order service, etc.) so we bail first.
		if (!extensions[PAYMENT_IDENTIFIER]) return;
		const id = await resolveId(context);
		const finalId = id || generatePaymentId();
		appendPaymentIdentifierToExtensions(extensions, finalId);
	});
	return client;
}

function buildResolver(options) {
	if (typeof options.getPaymentId === 'function') {
		return async (context) => {
			const v = await options.getPaymentId(context);
			return typeof v === 'string' && v ? v : null;
		};
	}
	if (typeof options.paymentId === 'string' && options.paymentId) {
		const fixed = options.paymentId;
		return async () => fixed;
	}
	return async () => null;
}

// Convenience: pull a stable per-tab `requestId` out of sessionStorage in
// browser flows. Falls back to a fresh generated id and writes it back so
// subsequent retries (page reload, navigation) reuse it.
//
// Returns a resolver suitable for `installIdempotency({ getPaymentId })`.
export function sessionStorageResolver({ keyPrefix = 'x402:pid:' } = {}) {
	return async (context) => {
		if (typeof sessionStorage === 'undefined') return null;
		const url = context?.paymentRequired?.resource?.url || 'default';
		const key = `${keyPrefix}${url}`;
		const existing = sessionStorage.getItem(key);
		if (existing && isValidPaymentId(existing)) return existing;
		const fresh = generatePaymentId();
		try {
			sessionStorage.setItem(key, fresh);
		} catch {
			// Storage may be unavailable (private mode, quota). Fall back to
			// per-call ids — the worst-case is reduced retry resilience.
		}
		return fresh;
	};
}

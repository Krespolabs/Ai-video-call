// POST /api/agents/a2a-cart-verify — verify a Cart Mandate.
//
// Cart Mandates are signed HS256 with the platform's mandate secret (three.ws is
// the mandate authority), so a peer or merchant that receives one can't verify it
// alone — they present it here. We check the signature, expiry, type, and that the
// cart body still hashes to the signed hash, then return the decoded cart. The
// caller can pass `expected` constraints to assert the mandate authorizes exactly
// the transaction they were asked to fulfill, in one round-trip.
//
// No auth: this is a public verification utility over a self-contained token; it
// reveals nothing the token holder doesn't already possess. Rate-limited.

import { cors, json, method, rateLimited, readJson, respondError, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { MandateError } from '../_lib/a2a/mandate.js';
import { assertCartMatchesPayment, verifyCartMandate } from '../_lib/a2a/cart-mandate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.mcpAgent(clientIp(req) || 'anon');
	if (!rl.success) return rateLimited(res, rl, 'cart verify rate limit exceeded');

	const body = await readJson(req);
	const { cartMandate: jws, expectedIntentMandateId, expected } = body || {};

	try {
		const cartMandate = await verifyCartMandate(jws, { expectedIntentMandateId });

		// Optional: assert the cart authorizes exactly the payment the verifier
		// expects (amount/network/resource/currency).
		if (expected && typeof expected === 'object') {
			assertCartMatchesPayment({
				cartMandate,
				amountAtomics: expected.amountAtomics,
				network: expected.network,
				resource: expected.resource,
				currency: expected.currency,
			});
		}

		return json(res, 200, { ok: true, valid: true, cart: cartMandate });
	} catch (err) {
		if (err instanceof MandateError) {
			// A failed verification is a normal, expected outcome — report it as a
			// structured 200 so callers can branch on `valid` without try/catch,
			// except for misconfiguration (500) which is a real server fault.
			if (err.status === 500) return respondError(res, 500, err.code, err);
			return json(res, 200, { ok: true, valid: false, code: err.code, reason: err.message });
		}
		throw err;
	}
});

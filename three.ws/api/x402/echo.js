// POST/GET /api/x402/echo
//
// httpbin for x402 — FREE, keyless. Returns exactly what your request looked
// like from this server's perspective: method, the headers that matter for a
// paid call, and your body. If an X-PAYMENT header is present (or you pass
// `paymentHeader` in the body), it is base64-decoded and echoed back with every
// signature and secret REDACTED to a short prefix, plus the rail's LOCAL
// verification verdict — the same pre-facilitator checks a real paid endpoint
// runs — WITHOUT settling or charging anything. Use it to see why your payload
// is being rejected before you spend a cent.
//
// Body (all optional): { paymentHeader?: string, requirement?: object }
//   paymentHeader — a base64 X-PAYMENT value to decode (alternative to the header)
//   requirement   — one accepts[] entry to check the payment against (amount/payTo)

import { wrap, cors, method, json, error, readJson, rateLimited, setRateLimitHeaders } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { redactPaymentEnvelope, structuralVerdict } from '../_lib/x402/dev-tools.js';
import { decodePaymentHeader } from '../_lib/x402-spec.js';

// Request headers a developer debugging an x402 call cares about. We never echo
// cookies, authorization bearer tokens, or the raw signed X-PAYMENT value.
const RELEVANT_HEADERS = [
	'content-type',
	'accept',
	'user-agent',
	'x-payment',
	'payment-signature',
	'x-provider-key',
	'x402-version',
];

// Summarize which payment-bearing headers were present (redacted) so a caller
// sees the server received their header without the value being replayable.
function headerView(req) {
	const out = {};
	for (const h of RELEVANT_HEADERS) {
		const v = req.headers?.[h];
		if (v === undefined) continue;
		if (h === 'x-payment' || h === 'payment-signature') {
			const s = String(v);
			out[h] = s.length > 10 ? `${s.slice(0, 10)}…(redacted, ${s.length} chars)` : '(present)';
		} else {
			out[h] = v;
		}
	}
	return out;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.x402DevToolIp(ip);
	if (!rl.success) return rateLimited(res, rl);
	setRateLimitHeaders(res, rl);

	let body = {};
	if (req.method === 'POST') {
		try {
			body = (await readJson(req)) || {};
		} catch (err) {
			return error(res, 400, 'invalid_json', err.message || 'request body must be valid JSON');
		}
	}

	const out = {
		ok: true,
		method: req.method,
		headers: headerView(req),
		body: req.method === 'POST' ? body : null,
		ts: new Date().toISOString(),
	};

	// Locate a payment envelope: the real X-PAYMENT header wins; else body.paymentHeader.
	const headerVal = req.headers?.['x-payment'] || req.headers?.['payment-signature'];
	const paymentHeader = headerVal || (typeof body.paymentHeader === 'string' ? body.paymentHeader : null);

	if (paymentHeader) {
		try {
			out.payment = redactPaymentEnvelope(paymentHeader);
			// Local structural verdict — never calls the facilitator, never settles.
			const decoded = decodePaymentHeader(paymentHeader);
			out.payment.verdict = structuralVerdict(decoded, body.requirement);
			out.payment.note =
				'Local pre-facilitator verdict only — no facilitator round-trip, no settlement, no charge.';
		} catch (err) {
			// A malformed header is the developer's answer, not a server error.
			out.payment = {
				decodable: false,
				error: err.code || 'invalid_payment',
				message: err.message,
			};
		}
	}

	return json(res, 200, out, { 'cache-control': 'no-store' });
});

// POST /api/x402/debug
//
// x402 exchange debugger — FREE, keyless. Paste any subset of a failed 402
// exchange and get a structured diagnosis of what's wrong and how to fix it,
// keyed to the real failure modes this server's payment rail produces.
//
// Body: { challenge?, payment?, response? } — any subset
//   challenge — the parsed 402 body you received ({ x402Version, accepts: [...] })
//   payment   — your DECODED X-PAYMENT payload (base64-decode it first, or run
//               /api/x402/echo to decode it for you)
//   response  — the error body the server returned ({ error, message, ... })
//
// Returns: { ok, findings: [{ severity, field, problem, fix }], count, ts }
//   ok is true only when no `error`-severity finding was raised.

import { wrap, cors, method, json, error, readJson, rateLimited, setRateLimitHeaders } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { diagnoseExchange } from '../_lib/x402/dev-tools.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.x402DevToolIp(ip);
	if (!rl.success) return rateLimited(res, rl);
	setRateLimitHeaders(res, rl);

	let body;
	try {
		body = (await readJson(req)) || {};
	} catch (err) {
		return error(res, 400, 'invalid_json', err.message || 'request body must be valid JSON');
	}

	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return error(res, 400, 'invalid_body', 'body must be a JSON object with any of { challenge, payment, response }');
	}

	const { findings, ok } = diagnoseExchange({
		challenge: body.challenge,
		payment: body.payment,
		response: body.response,
	});

	return json(res, 200, { ok, findings, count: findings.length, ts: new Date().toISOString() }, {
		'cache-control': 'no-store',
	});
});

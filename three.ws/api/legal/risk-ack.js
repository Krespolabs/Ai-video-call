// /api/legal/risk-ack: sign, and check, the real-funds agreements.
//
//   GET  /api/legal/risk-ack
//     → 200 { authenticated, signed, version, signedAt, documents, history? }
//       history (the account's past signatures) only with ?history=1 and a session.
//
//   POST /api/legal/risk-ack
//     { version, documents: {tos, risk, agentWallet}, attestations: {eligible, noLiability},
//       signatureName, context?, path? }
//     → 200 { ok: true, recorded: true, version }
//     → 400 invalid_body | invalid_version | document_not_accepted |
//           attestation_missing | invalid_signature
//     → 413 payload_too_large, 415 unsupported_media_type
//     → 503 signature_not_recorded when the durable write did not land
//
// The signing dialog (public/risk-ack.js) posts here before any real-funds
// action. The row in legal_signatures is what requireRealFundsAgreement()
// (api/_lib/real-funds-agreement.js) checks on every money-moving endpoint,
// so a write that did not land is a failure the caller must see: the dialog
// stays open and asks the person to sign again, rather than letting them walk
// into a refusal on the very next request.
//
// Anonymous signatures are recorded too (user_id null): a visitor funding
// someone else's agent, or paying through the x402 embed on a merchant site,
// signs before any session exists. The audit-log-cleanup cron exempts the
// matching 'risk-ack-accept' audit rows from retention, and legal_signatures
// is never pruned.

import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	agreementRequirement,
	currentSignatureFor,
	recordRealFundsSignature,
	signatureHistoryFor,
	validateSignatureBody,
} from '../_lib/real-funds-agreement.js';
import { RISK_ACK_VERSION } from '../../public/risk-ack.js';

export default wrap(async function handler(req, res) {
	// '*' origin: the signing dialog also runs inside the drop-in x402 embed on
	// merchant sites. Those requests are credential-less and sign anonymously,
	// so '*' is safe; a session-bearing signature only comes from our origin.
	if (cors(req, res, { origins: '*', methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'GET') return handleStatus(req, res);
	return handleSign(req, res);
});

async function handleStatus(req, res) {
	const user = await getSessionUser(req).catch(() => null);
	const base = { version: RISK_ACK_VERSION, documents: agreementRequirement().documents };
	if (!user) {
		return json(res, 200, { authenticated: false, signed: false, signedAt: null, ...base }, { 'cache-control': 'no-store' });
	}
	let signature;
	try {
		signature = await currentSignatureFor(user.id);
	} catch {
		return error(res, 503, 'status_unavailable', 'could not read your signed agreements, try again');
	}
	const out = {
		authenticated: true,
		signed: !!signature,
		signedAt: signature?.signedAt ?? null,
		signatureName: signature?.signatureName ?? null,
		...base,
	};
	const url = new URL(req.url, 'http://local');
	if (url.searchParams.get('history') === '1') {
		out.history = await signatureHistoryFor(user.id).catch(() => []);
	}
	return json(res, 200, out, { 'cache-control': 'no-store' });
}

async function handleSign(req, res) {
	let body;
	try {
		body = await readJson(req, 10_000);
	} catch (err) {
		const status = err?.status === 413 || err?.status === 415 ? err.status : 400;
		const code =
			status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : 'bad_request';
		return error(res, status, code, err?.message || 'could not read request body');
	}

	const parsed = validateSignatureBody(body);
	if (!parsed.ok) return error(res, 400, parsed.code, parsed.message);

	const user = await getSessionUser(req).catch(() => null);
	const recorded = await recordRealFundsSignature({ userId: user?.id ?? null, value: parsed.value, req });
	if (!recorded) {
		return error(
			res,
			503,
			'signature_not_recorded',
			'your signature could not be saved; nothing was charged, please sign again',
		);
	}
	return json(res, 200, { ok: true, recorded: true, version: RISK_ACK_VERSION }, { 'cache-control': 'no-store' });
}

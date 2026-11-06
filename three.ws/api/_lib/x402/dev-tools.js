// Pure logic for the free x402 developer toolkit (echo / debug / verify-receipt).
//
// Kept I/O-free so every branch is unit-testable without a network or a live
// facilitator. The route handlers in api/x402/{echo,debug,verify-receipt}.js are
// thin wrappers that add CORS, rate limiting, and body parsing on top of these.
//
// Three capabilities:
//   • redactPaymentEnvelope() — decode an X-PAYMENT header and strip every
//     signature/secret down to a short prefix so echo can show a developer the
//     server's view of their payload WITHOUT leaking a reusable authorization.
//   • structuralVerdict()     — the rail's LOCAL verification (shape + signed
//     amount vs required + signed recipient vs payTo + builder-code echo). No
//     facilitator round-trip, no settlement — a fast, safe "would this pass our
//     own pre-facilitator checks?" verdict.
//   • diagnoseExchange()      — turn a failed 402 exchange (challenge / payment /
//     response, any subset) into a [{severity, field, problem, fix}] list keyed
//     to the real failure modes our rail produces.
//   • recomputeAttestation() / verifyAttestation() — recompute a three.ws
//     SHA-256 response attestation (fact-check style) and confirm/deny integrity.

import { createHash } from 'crypto';

import {
	decodePaymentHeader,
	decodeSignedAmount,
	decodeSignedRecipient,
	X402_VERSION,
	NETWORK_BASE_MAINNET,
	NETWORK_SOLANA_MAINNET,
} from '../x402-spec.js';

// Every field name whose value is a signature, private authorization, or other
// secret that must never be echoed back in full. Matched case-insensitively,
// substring — `signature`, `sig`, `authorization`, `secret`, `privateKey`, etc.
const SECRET_KEY_PATTERNS = [
	'signature',
	'sig',
	'secret',
	'privatekey',
	'private_key',
	'mnemonic',
	'seed',
	'password',
	'passphrase',
];

// How many leading characters of a redacted secret to keep, so a developer can
// still eyeball "yes that's my sig" without the value being replayable.
const REDACT_KEEP = 10;

function looksSecret(key) {
	const k = String(key).toLowerCase();
	return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

// Replace a secret value with `<prefix>…(redacted, N chars)`. Non-string
// secrets (rare) collapse to a type marker so nothing sensitive survives.
function redactValue(value) {
	if (typeof value !== 'string') return '<redacted:non-string>';
	if (value.length <= REDACT_KEEP) return `${value}…(redacted)`;
	return `${value.slice(0, REDACT_KEEP)}…(redacted, ${value.length} chars)`;
}

// Deep-clone `obj`, redacting any value whose key looks like a secret. Also
// redacts long hex/base64 blobs living under an `authorization` object even when
// the key itself is innocuous (e.g. EIP-3009 `v`/`r`/`s` split signatures).
export function redactSecrets(obj, { inAuthorization = false } = {}) {
	if (Array.isArray(obj)) return obj.map((v) => redactSecrets(v, { inAuthorization }));
	if (obj && typeof obj === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(obj)) {
			const childInAuth = inAuthorization || k.toLowerCase() === 'authorization';
			if (looksSecret(k)) {
				out[k] = redactValue(v);
			} else if (
				childInAuth &&
				typeof v === 'string' &&
				/^0x[0-9a-fA-F]{16,}$/.test(v)
			) {
				// A long 0x blob inside the signed authorization is signature
				// material regardless of its field name — redact it too.
				out[k] = redactValue(v);
			} else if (v && typeof v === 'object') {
				out[k] = redactSecrets(v, { inAuthorization: childInAuth });
			} else {
				out[k] = v;
			}
		}
		return out;
	}
	return obj;
}

// Decode an X-PAYMENT header and return a redacted view of the envelope plus the
// fields a developer needs to debug: version, scheme, network, and the located
// signed amount/recipient. Throws on a structurally invalid header (base64 / JSON
// / not-an-object) — the caller maps that to a 400 with the thrown message.
export function redactPaymentEnvelope(paymentHeader) {
	const payload = decodePaymentHeader(paymentHeader); // throws X402Error on bad shape
	const signedAmount = decodeSignedAmount(payload);
	const signedRecipient = decodeSignedRecipient(payload);
	return {
		x402Version: payload.x402Version ?? null,
		scheme: payload.scheme ?? payload.accepted?.scheme ?? null,
		network: payload.network ?? payload.accepted?.network ?? null,
		signedAmount: signedAmount === null ? null : signedAmount.toString(),
		signedRecipient,
		envelope: redactSecrets(payload),
	};
}

// The rail's LOCAL pre-facilitator verdict for a decoded payment against a single
// requirement (accept entry). Mirrors the defense-in-depth checks verifyPayment()
// runs before ever calling the facilitator, but performs no network I/O and never
// settles. Returns { valid, checks[], reason? }.
//
// `requirement` is one accepts[] entry ({ scheme, network, amount, payTo, ... }).
// When omitted, only the envelope-shape checks run (amount/recipient are reported
// as "no requirement to compare against").
export function structuralVerdict(payload, requirement) {
	const checks = [];
	const fail = (field, detail) => checks.push({ field, pass: false, detail });
	const pass = (field, detail) => checks.push({ field, pass: true, detail });

	// Shape.
	if (!payload || typeof payload !== 'object') {
		return { valid: false, checks: [{ field: 'payload', pass: false, detail: 'not an object' }], reason: 'payload is not an object' };
	}
	if (payload.x402Version === X402_VERSION) pass('x402Version', `is ${X402_VERSION}`);
	else fail('x402Version', `expected ${X402_VERSION}, got ${payload.x402Version ?? 'undefined'}`);

	const scheme = payload.scheme ?? payload.accepted?.scheme;
	if (scheme) pass('scheme', String(scheme));
	else fail('scheme', 'missing scheme (top-level or accepted.scheme)');

	const network = payload.network ?? payload.accepted?.network;
	if (network) pass('network', String(network));
	else fail('network', 'missing network');

	// Amount: the signed amount must be ≥ the required amount (underpayment guard).
	const signedAmount = decodeSignedAmount(payload);
	if (requirement && requirement.amount != null) {
		if (signedAmount === null) {
			pass('amount', 'signed amount not locally decodable (Solana SPL / opaque) — facilitator-trusted');
		} else {
			let required = null;
			try {
				required = BigInt(requirement.amount);
			} catch {
				fail('amount', `requirement.amount "${requirement.amount}" is not an integer string`);
			}
			if (required !== null) {
				if (signedAmount >= required) pass('amount', `signed ${signedAmount} ≥ required ${required}`);
				else fail('amount', `signed ${signedAmount} < required ${required} (underpayment)`);
			}
		}
	} else if (signedAmount !== null) {
		pass('amount', `signed ${signedAmount} (no requirement supplied to compare)`);
	}

	// Recipient: the signed `to` must equal the requirement's payTo.
	const signedRecipient = decodeSignedRecipient(payload);
	if (requirement && requirement.payTo) {
		if (signedRecipient === null) {
			pass('payTo', 'signed recipient not locally decodable — facilitator-trusted');
		} else if (signedRecipient === String(requirement.payTo).toLowerCase()) {
			pass('payTo', 'signed recipient matches requirement.payTo');
		} else {
			fail('payTo', `signed recipient ${signedRecipient} ≠ requirement.payTo ${String(requirement.payTo).toLowerCase()}`);
		}
	}

	const failed = checks.filter((c) => !c.pass);
	return {
		valid: failed.length === 0,
		checks,
		...(failed.length ? { reason: failed.map((c) => `${c.field}: ${c.detail}`).join('; ') } : {}),
	};
}

// Known networks our rail settles on, for the debugger's network sanity check.
const KNOWN_NETWORKS = new Set([
	NETWORK_BASE_MAINNET,
	NETWORK_SOLANA_MAINNET,
	'eip155:42161',
	'eip155:56',
	'eip155:196',
]);

// Common shorthand a developer might send instead of the CAIP-2 id our accepts[]
// advertise — flagged with the canonical form as the fix.
const NETWORK_ALIASES = {
	base: NETWORK_BASE_MAINNET,
	'base-mainnet': NETWORK_BASE_MAINNET,
	solana: NETWORK_SOLANA_MAINNET,
	'solana-mainnet': NETWORK_SOLANA_MAINNET,
	arbitrum: 'eip155:42161',
	bsc: 'eip155:56',
	xlayer: 'eip155:196',
};

// Diagnose a failed x402 exchange. `input` may carry any subset of
// { challenge, payment, response }. Returns a flat list of findings ordered
// most-severe first: [{ severity: 'error'|'warning'|'info', field, problem, fix }].
export function diagnoseExchange(input = {}) {
	const findings = [];
	const add = (severity, field, problem, fix) => findings.push({ severity, field, problem, fix });

	const { challenge, payment, response } = input || {};

	if (challenge === undefined && payment === undefined && response === undefined) {
		add('error', 'input', 'no challenge, payment, or response supplied', 'POST at least one of { challenge, payment, response } — the 402 body, your X-PAYMENT payload (decoded), and/or the server response you got back.');
		return { findings, ok: false };
	}

	// ── Challenge (the 402 body the server sent) ────────────────────────────
	let accepts = null;
	if (challenge !== undefined) {
		if (!challenge || typeof challenge !== 'object') {
			add('error', 'challenge', 'challenge is not a JSON object', 'Paste the parsed 402 response body, e.g. { x402Version, accepts: [...] }.');
		} else {
			if (challenge.x402Version !== undefined && challenge.x402Version !== X402_VERSION) {
				add('warning', 'challenge.x402Version', `challenge advertises x402Version ${challenge.x402Version}; this server speaks ${X402_VERSION}`, `Send x402Version: ${X402_VERSION} in your payment payload.`);
			}
			accepts = challenge.accepts || challenge.requirements || null;
			if (!Array.isArray(accepts) || accepts.length === 0) {
				add('error', 'challenge.accepts', 'challenge has no accepts[] array', 'A valid 402 body carries accepts[] (v2) or requirements[] (legacy) with at least one payment option.');
			} else {
				for (let i = 0; i < accepts.length; i++) {
					const a = accepts[i];
					if (a?.amount != null && !/^\d+$/.test(String(a.amount))) {
						add('error', `challenge.accepts[${i}].amount`, `amount "${a.amount}" is not an integer atomic-units string`, 'amount is in the asset\'s smallest unit as a string (USDC 6-decimals → "10000" = $0.01), never a decimal like "0.01".');
					}
				}
			}
		}
	}

	// ── Payment (the decoded X-PAYMENT payload the caller signed) ───────────
	if (payment !== undefined) {
		if (!payment || typeof payment !== 'object') {
			add('error', 'payment', 'payment is not a JSON object', 'Base64-decode your X-PAYMENT header and paste the resulting JSON here (or POST the raw header to /api/x402/echo).');
		} else {
			if (payment.x402Version !== undefined && payment.x402Version !== X402_VERSION) {
				add('error', 'payment.x402Version', `payment declares x402Version ${payment.x402Version}; server requires ${X402_VERSION}`, `Set x402Version: ${X402_VERSION}.`);
			} else if (payment.x402Version === undefined) {
				add('warning', 'payment.x402Version', 'payment payload omits x402Version', `Include x402Version: ${X402_VERSION}.`);
			}
			const net = payment.network ?? payment.accepted?.network;
			if (net) {
				const alias = NETWORK_ALIASES[String(net).toLowerCase()];
				if (alias && alias !== net) {
					add('error', 'payment.network', `network "${net}" is a shorthand, not the CAIP-2 id the rail matches on`, `Use "${alias}".`);
				} else if (!KNOWN_NETWORKS.has(net) && !alias) {
					add('warning', 'payment.network', `network "${net}" is not one this server advertises`, 'Copy the exact network string from an accepts[] entry in the 402 challenge.');
				}
				// Cross-check against the challenge's offered networks.
				if (Array.isArray(accepts) && accepts.length) {
					const offered = accepts.map((a) => a.network).filter(Boolean);
					if (offered.length && !offered.includes(net)) {
						add('error', 'payment.network', `you signed for "${net}" but the challenge only offers [${offered.join(', ')}]`, 'Pick one of the offered networks and re-sign against that accepts[] entry.');
					}
				}
			} else {
				add('error', 'payment.network', 'payment payload has no network', 'Set network to the CAIP-2 id from the accepts[] entry you chose.');
			}

			// Amount vs the matching accept.
			const signed = decodeSignedAmount(payment);
			if (signed !== null && Array.isArray(accepts) && accepts.length) {
				const match = accepts.find((a) => a.network === (payment.network ?? payment.accepted?.network)) || accepts[0];
				if (match?.amount != null && /^\d+$/.test(String(match.amount))) {
					const required = BigInt(match.amount);
					if (signed < required) {
						add('error', 'payment.authorization.value', `signed amount ${signed} is below the required ${required}`, 'Sign an authorization for at least the amount in the accepts[] entry (atomic units).');
					}
				}
			}
			// Decimal-vs-atomic footgun: an authorization value that looks like a
			// human decimal ("0.01") never parses as atomic units.
			const rawVal = payment?.payload?.authorization?.value;
			if (typeof rawVal === 'string' && rawVal.includes('.')) {
				add('error', 'payment.authorization.value', `value "${rawVal}" contains a decimal point`, 'Authorization value is atomic units as an integer string ("10000"), not a decimal token amount.');
			}
		}
	}

	// ── Response (the server's error the caller got back) ───────────────────
	if (response !== undefined && response && typeof response === 'object') {
		const code = response.error || response.code;
		const known = {
			payment_required: 'No X-PAYMENT header was sent (or it was empty). Attach your base64 payment payload as the X-PAYMENT header and retry.',
			invalid_payment: 'The payload was structurally valid but failed a check — usually underpayment, wrong payTo, or a malformed authorization. Run /api/x402/echo on your header to see the decoded amount/recipient.',
			unsupported_network: 'The network in your payload is not one this resource offers. Use a network from the challenge accepts[].',
			builder_code_tampered: 'The builder-code extension in your payload does not echo the one the challenge declared. Do not modify extensions[]; pass them through verbatim.',
		};
		if (code && known[code]) {
			add('info', 'response.error', `server returned "${code}"`, known[code]);
		} else if (code) {
			add('info', 'response.error', `server returned "${code}"`, 'See docs/x402 for the full error catalog.');
		}
	}

	// Order: error → warning → info.
	const rank = { error: 0, warning: 1, info: 2 };
	findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
	return { findings, ok: findings.every((f) => f.severity !== 'error') };
}

// Recompute a three.ws fact-check style attestation from the response fields it
// commits to. The scheme (api/x402/fact-check.js) is:
//   "sha256:" + sha256(JSON.stringify({ verdict, confidence, claim, sources: [urls] }))
// Returns the recomputed "sha256:<hex>" string.
export function recomputeAttestation(result) {
	const sources = Array.isArray(result?.sources)
		? result.sources.map((s) => (typeof s === 'string' ? s : s?.url)).filter(Boolean)
		: [];
	return (
		'sha256:' +
		createHash('sha256')
			.update(
				JSON.stringify({
					verdict: result?.verdict,
					confidence: result?.confidence,
					claim: result?.claim,
					sources,
				}),
			)
			.digest('hex')
	);
}

// Confirm/deny a claimed attestation against the result it was computed over.
// Returns { verified, scheme, recomputed, claimed, mismatchReason? }.
export function verifyAttestation(result) {
	const claimed = result?.attestation;
	if (typeof claimed !== 'string' || !claimed.startsWith('sha256:')) {
		return {
			verified: false,
			scheme: 'sha256',
			recomputed: null,
			claimed: claimed ?? null,
			mismatchReason: 'no sha256: attestation string present on the object',
		};
	}
	// Everything the scheme hashes must be present, else "verified: true" would be
	// vacuous (hashing undefineds).
	const missing = ['verdict', 'confidence', 'claim', 'sources'].filter(
		(k) => result[k] === undefined || result[k] === null,
	);
	if (missing.length) {
		return {
			verified: false,
			scheme: 'sha256',
			recomputed: null,
			claimed,
			mismatchReason: `cannot recompute — the attested fields are missing: ${missing.join(', ')}`,
		};
	}
	const recomputed = recomputeAttestation(result);
	return {
		verified: recomputed === claimed,
		scheme: 'sha256',
		recomputed,
		claimed,
		...(recomputed === claimed ? {} : { mismatchReason: 'recomputed digest does not match the attested one — the object was altered after signing' }),
	};
}

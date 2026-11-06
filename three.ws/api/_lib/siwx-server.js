// Server-side glue between @x402/extensions/sign-in-with-x and our
// paidEndpoint() wrapper. Keeps the verification path, extension declaration,
// and EVM smart-wallet verifier in one place so each new endpoint doesn't
// have to repeat them.
//
// The SIWX flow:
//   1. paidEndpoint() declares the 'sign-in-with-x' extension in every 402
//      body (declareSiwxExtensionFor below).
//   2. A returning buyer sends `SIGN-IN-WITH-X: <base64>` instead of the
//      X-PAYMENT header. authenticateSiwx() parses, validates, verifies
//      the CAIP-122 signature, looks up the (resource, address) grant in
//      siwx_payments, and on success the handler runs without settlement.
//   3. A fresh buyer settles with X-PAYMENT as usual; recordSiwxPayment()
//      then writes the grant so step 2 works next time.

import {
	createSIWxResourceServerExtension,
	declareSIWxExtension,
	parseSIWxHeader,
	validateSIWxMessage,
	verifySIWxSignature,
	SIGN_IN_WITH_X,
} from '@x402/extensions/sign-in-with-x';

import { createPublicClient } from 'viem';
import { base } from 'viem/chains';
import { evmTransport } from './evm/rpc.js';

import { env } from './env.js';
import { siwxStorage, normalizeAddress } from './siwx-storage.js';

export { SIGN_IN_WITH_X };

// @x402/extensions >= 2.25 binds a resource-server extension to one configured
// origin and throws at construction when none is given, so the extension can no
// longer be a module-level singleton built from storage alone (that threw on
// import and took every paidEndpoint() route down with it). The origin comes
// from the resource URL, which the server builds from env.APP_ORIGIN and never
// from a request header, so a caller cannot steer it. One extension per origin,
// built on first use.
const extensionsByOrigin = new Map();

function siwxOriginOf(resourceUrl) {
	return new URL(resourceUrl).origin;
}

function extensionFor(resourceUrl) {
	const origin = siwxOriginOf(resourceUrl);
	let extension = extensionsByOrigin.get(origin);
	if (!extension) {
		extension = createSIWxResourceServerExtension({ storage: siwxStorage, origin });
		extensionsByOrigin.set(origin, extension);
	}
	return extension;
}

// Lazily build a viem PublicClient so verifySIWxSignature can verify
// smart-contract wallets (EIP-1271) and counterfactual wallets (EIP-6492).
// Uses our private RPC (env.BASE_RPC_URL) first so buyer addresses are not
// broadcast to a public node on the happy path; the shared Base endpoint chain
// only takes over when the private node fails, so it can never be the single
// point that blocks every smart-wallet sign-in. Returns undefined when
// BASE_RPC_URL isn't configured; the upstream verifier then falls back to
// EOA-only verification.
let _baseClient;
function getEvmVerifier() {
	if (!env.BASE_RPC_URL) return undefined;
	if (!_baseClient) {
		_baseClient = createPublicClient({
			chain: base,
			transport: evmTransport(base.id, { primaryUrl: env.BASE_RPC_URL }),
		});
	}
	return _baseClient.verifyMessage.bind(_baseClient);
}

export function hasEvmVerifier() {
	return Boolean(env.BASE_RPC_URL);
}

// Build the SIWX extension block for the 402 body. `declareSIWxExtension`
// alone returns a stub: the SDK pipeline normally calls
// `siwxResourceServerExtension.enrichPaymentRequiredResponse` to fill in
// nonce, issuedAt, domain, uri, and the supportedChains list. paidEndpoint()
// doesn't run that pipeline, so we invoke enrich() ourselves with the
// context (resourceUrl + requirements) the helper already has.
export async function declareSiwxExtensionFor({
	networks,
	resourceUrl,
	statement,
	expirationSeconds = 300,
}) {
	const list = Array.isArray(networks) ? networks : [networks];
	const unique = [...new Set(list.filter(Boolean))];
	if (!unique.length) {
		throw new Error('declareSiwxExtensionFor: at least one network required');
	}
	if (!resourceUrl) {
		throw new Error('declareSiwxExtensionFor: resourceUrl required');
	}
	const stub = declareSIWxExtension({
		network: unique.length === 1 ? unique[0] : unique,
		statement,
		expirationSeconds,
	});
	const declaration = stub[SIGN_IN_WITH_X];
	const enriched = await extensionFor(resourceUrl).enrichPaymentRequiredResponse(declaration, {
		resourceInfo: { url: resourceUrl },
		requirements: unique.map((network) => ({ network })),
	});
	return { [SIGN_IN_WITH_X]: enriched };
}

// Check a parsed SIWX payload: the message must belong to this origin, be
// fresh, and carry an unused nonce, and the signature must verify (EOA,
// EIP-1271, EIP-6492, or Solana ed25519). Shared by the paidEndpoint() re-entry
// path below and the auth-hints path (api/_lib/x402/auth-hints.js) so both
// track the library's result shape in one place. Returns
// `{ ok: true, address }` with the address already normalized, or
// `{ ok: false, stage: 'message' | 'signature', error }`.
export async function verifySiwxProof({ payload, resourceUrl }) {
	const validation = await validateSIWxMessage(payload, new URL(siwxOriginOf(resourceUrl)), {
		maxAge: 5 * 60 * 1000,
		checkNonce: async (n) => !(await siwxStorage.hasUsedNonce(n)),
	});
	if (!validation.isValid) {
		return { ok: false, stage: 'message', error: validation.invalidMessage };
	}

	const verification = await verifySIWxSignature(payload, { evmVerifier: getEvmVerifier() });
	if (!verification.isValid || !verification.payer) {
		return { ok: false, stage: 'signature', error: verification.invalidMessage };
	}

	return { ok: true, address: normalizeAddress(payload.chainId, verification.payer) };
}

// Given an incoming Vercel request, attempt to authenticate via
// SIGN-IN-WITH-X. Returns:
//   { ok: true, address, network } on full success.
//   { ok: false, status, code, error } on validation / verification / grant
//     failure (caller emits the matching HTTP status).
//   null when the header is absent — caller continues with the X-PAYMENT
//     flow.
export async function authenticateSiwx({ req, resourceUrl }) {
	const header =
		req.headers['sign-in-with-x'] ||
		req.headers['SIGN-IN-WITH-X'] ||
		req.headers['Sign-In-With-X'];
	if (!header) return null;

	let payload;
	try {
		payload = parseSIWxHeader(String(header));
	} catch (err) {
		return { ok: false, status: 400, code: 'siwx_parse_failed', error: err.message };
	}

	const proof = await verifySiwxProof({ payload, resourceUrl });
	if (!proof.ok) {
		const code = proof.stage === 'message' ? 'siwx_message_invalid' : 'siwx_signature_invalid';
		return { ok: false, status: 401, code, error: proof.error };
	}

	const normalizedAddress = proof.address;
	if (!(await siwxStorage.hasPaid(resourceUrl, normalizedAddress))) {
		return {
			ok: false,
			status: 402,
			code: 'siwx_not_paid',
			error: 'wallet has not paid for this resource',
		};
	}

	// Atomically claim the nonce. The earlier checkNonce read is only a fast
	// pre-filter; this INSERT is the authority. Two concurrent requests with
	// the same captured proof both clear validation, but only the winner of
	// the insert is granted — the loser is a replay and re-issues a 402.
	const claimed = await siwxStorage.recordNonce(payload.nonce, {
		resource: resourceUrl,
		address: normalizedAddress,
	});
	if (!claimed) {
		return {
			ok: false,
			status: 402,
			code: 'siwx_nonce_replayed',
			error: 'sign-in proof already used; sign a fresh challenge',
		};
	}

	return { ok: true, address: normalizedAddress, network: payload.chainId };
}

// Record a fresh payment so the wallet can re-enter via SIWX next time. Called
// from paidEndpoint() after a successful facilitator settle. The `payer` is the
// canonical CAIP-122 address (lowercase hex for EVM, Base58 for Solana); the
// caller already normalizes via normalizeAddress() before passing it in.
export async function recordSiwxPayment({ resourceUrl, payer, network, ttlSeconds = null }) {
	if (!payer) return;
	await siwxStorage.recordPayment(resourceUrl, payer, { network, ttlSeconds });
}

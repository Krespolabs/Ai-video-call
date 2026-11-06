// x402 Offer & Receipt extension — issuer setup.
//
// Constructs the OfferReceiptIssuer that signs both 402 offers (per accept
// entry) and 200 receipts (after settlement). The signing key MUST NOT be
// any X402_PAY_TO_* wallet — those receive funds; this one only signs
// off-chain commitments. Mixing the two would mean every payment cosigner
// is implicitly endorsing every offer/receipt the server ever issued.
//
// Two formats are supported:
//
//   • EIP-712 (default, OFFER_RECEIPT_FORMAT=eip712)
//     Signs with a dedicated EVM EOA from OFFER_RECEIPT_SIGNING_PRIVATE_KEY.
//     The kid is did:pkh:eip155:1:<address>#key-1 (per spec §3.2 the EIP-712
//     domain chainId is hard-pinned at 1 regardless of payment network, so
//     did:pkh uses chain-id 1 for consistency with the signing domain).
//     Verifiers recover the signer address from the signature and check it
//     against the address embedded in the kid.
//
//   • JWS (OFFER_RECEIPT_FORMAT=jws)
//     Signs with a JWK private key from OFFER_RECEIPT_JWK (JSON string). The
//     kid is did:web:<SERVER_DOMAIN>#key-1 — verifiers fetch
//     https://<SERVER_DOMAIN>/.well-known/did.json (see api/x402/did.js) to
//     resolve the public key. Default algorithm is EdDSA (Ed25519); ES256K
//     (secp256k1) is also accepted via OFFER_RECEIPT_JWS_ALG. Vercel has no
//     KMS — for production-grade key management, swap this for a managed
//     KMS signer (GCP KMS, AWS KMS, HashiCorp Vault) and have the sign()
//     callback delegate to the KMS API.
//
// When OFFER_RECEIPT_SIGNING_PRIVATE_KEY (eip712) or OFFER_RECEIPT_JWK (jws)
// is unset, getIssuer() returns null and callers MUST silently skip emitting
// the extension. The x402 wire format stays valid without it; the extension
// is purely additive.

import {
	createEIP712OfferReceiptIssuer,
	createJWSOfferReceiptIssuer,
} from '@x402/extensions';
import * as jose from 'jose';
import { privateKeyToAccount } from 'viem/accounts';

import { env } from '../env.js';

let _issuerCache = null;
let _issuerError = null;

// Each callable reads an env value and returns the address to compare against,
// or null when the env is unset / the key itself is malformed. Wrapped in
// try/catch because some envs (AGENT_RELAYER_KEY) are declared `req()` and
// throw when unset — that throw must not stop us from running the safeguard.
function deriveAddressIfPossible(envFn) {
	let raw;
	try {
		raw = envFn();
	} catch {
		return null;
	}
	if (!raw) return null;
	const trimmed = String(raw).trim();
	if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return trimmed.toLowerCase();
	try {
		const norm = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
		return privateKeyToAccount(norm).address.toLowerCase();
	} catch {
		return null;
	}
}

function safeguardAgainstReusingPaymentKey(signingPrivKey) {
	const norm = signingPrivKey.startsWith('0x') ? signingPrivKey : `0x${signingPrivKey}`;
	let derivedAddress;
	try {
		derivedAddress = privateKeyToAccount(norm).address.toLowerCase();
	} catch {
		throw new Error('OFFER_RECEIPT_SIGNING_PRIVATE_KEY is not a valid 0x-hex EVM private key');
	}
	const collisions = [
		['X402_PAY_TO_BASE', deriveAddressIfPossible(() => env.X402_PAY_TO_BASE)],
		['X402_PAY_TO_BSC', deriveAddressIfPossible(() => env.X402_PAY_TO_BSC)],
		['CLUB_EVM_TREASURY_PRIVATE_KEY', deriveAddressIfPossible(() => env.CLUB_EVM_TREASURY_PRIVATE_KEY)],
		['AGENT_RELAYER_KEY', deriveAddressIfPossible(() => env.AGENT_RELAYER_KEY)],
	];
	for (const [name, addr] of collisions) {
		if (!addr) continue;
		if (addr === derivedAddress) {
			throw new Error(
				`OFFER_RECEIPT_SIGNING_PRIVATE_KEY derives to ${derivedAddress}, which is also ${name}. ` +
				'Receipts MUST be signed with a dedicated key separate from payment-receiving wallets.',
			);
		}
	}
	return derivedAddress;
}

async function buildEip712Issuer() {
	const privKey = env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY;
	if (!privKey) return null;
	const norm = privKey.startsWith('0x') ? privKey : `0x${privKey}`;
	const address = safeguardAgainstReusingPaymentKey(privKey);
	const account = privateKeyToAccount(norm);
	// Per spec §3.2 the EIP-712 domain chainId is hard-pinned at 1 (off-chain
	// signing context, NOT the payment network). did:pkh follows the same
	// convention so the kid is interpretable without knowing the payment chain.
	const kid = `did:pkh:eip155:1:${account.address}#key-1`;
	const signTypedData = (params) => account.signTypedData(params);
	const issuer = createEIP712OfferReceiptIssuer(kid, signTypedData);
	return {
		issuer,
		format: 'eip712',
		kid,
		signerAddress: address,
		publicKey: null,
	};
}

async function buildJwsIssuer() {
	const rawJwk = env.OFFER_RECEIPT_JWK;
	if (!rawJwk) return null;
	let jwk;
	try {
		jwk = typeof rawJwk === 'string' ? JSON.parse(rawJwk) : rawJwk;
	} catch (err) {
		throw new Error(`OFFER_RECEIPT_JWK is not valid JSON: ${err.message}`);
	}
	const algorithm = env.OFFER_RECEIPT_JWS_ALG;
	const privateKey = await jose.importJWK(jwk, algorithm);
	const kid = `did:web:${env.SERVER_DOMAIN}#key-1`;
	const jwsSigner = {
		kid,
		algorithm,
		format: 'jws',
		// The SDK calls sign(bytes) and expects a base64url-encoded raw
		// signature string. jose.FlattenedSign gives us full JWS control;
		// we strip the wrapper and return only the signature field.
		async sign(payloadBytes) {
			const sig = await new jose.FlattenedSign(payloadBytes)
				.setProtectedHeader({ alg: algorithm, kid })
				.sign(privateKey);
			return sig.signature;
		},
	};
	const issuer = createJWSOfferReceiptIssuer(kid, jwsSigner);
	// Strip private components from the JWK before exposing for /.well-known/did.json.
	const publicJwk = { ...jwk };
	for (const k of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) delete publicJwk[k];
	return {
		issuer,
		format: 'jws',
		kid,
		signerAddress: null,
		publicKey: { jwk: publicJwk, alg: algorithm },
	};
}

/**
 * Return the configured offer-receipt issuer, or null when no signing key is
 * configured. Throws if a key is configured but invalid (fail-fast on boot).
 */
export async function getIssuer() {
	// After the first initialization failure the error was already logged by the
	// caller. Re-throwing on every subsequent request would spam the error log;
	// return null so the offers extension is silently skipped instead.
	if (_issuerError) return null;
	if (_issuerCache !== null) return _issuerCache;
	const format = (env.OFFER_RECEIPT_FORMAT || 'eip712').toLowerCase();
	try {
		const built = format === 'jws' ? await buildJwsIssuer() : await buildEip712Issuer();
		_issuerCache = built ?? false;
	} catch (err) {
		_issuerError = err;
		throw err;
	}
	return _issuerCache || null;
}

/** Reset the memoised issuer — for tests only. */
export function _resetIssuerForTests() {
	_issuerCache = null;
	_issuerError = null;
}

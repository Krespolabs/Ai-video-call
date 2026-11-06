// x402 Offer & Receipt — declaration helper + EIP-712 issuer module.
//
// Two concerns live here:
//
//   offerReceiptDeclaration()          — static capability declaration for the
//     402 body's `extensions` map (uses OFFER_RECEIPT_SIGNING_PRIVATE_KEY /
//     OFFER_RECEIPT_JWK and the existing offer-receipt-issuer stack).
//
//   issuer / signOffersForAccepts / signReceipt  — EIP-712 signing primitives
//     keyed by X402_RECEIPT_SIGNING_KEY. `issuer` is null when the var is unset
//     (the no-op / rollback toggle — unset in Vercel to disable without
//     redeploying code). Signing key MUST NOT be any X402_PAY_TO_* wallet.

import {
	createEIP712OfferReceiptIssuer,
	convertNetworkStringToCAIP2,
	declareOfferReceiptExtension,
} from '@x402/extensions/offer-receipt';
import { privateKeyToAccount } from 'viem/accounts';

import { env } from './env.js';

// ── Static capability declaration (used by x402-spec.js / build402Body) ─────

/**
 * Returns the `extensions["offer-receipt"]` declaration fragment for the 402
 * body when a signing key is configured, null otherwise. Checks both the legacy
 * OFFER_RECEIPT_SIGNING_PRIVATE_KEY/OFFER_RECEIPT_JWK vars (used by the
 * offer-receipt-server stack) and the new X402_RECEIPT_SIGNING_KEY (issuer).
 */
export function offerReceiptDeclaration() {
	if (!env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY && !env.OFFER_RECEIPT_JWK && !issuer) return null;
	return declareOfferReceiptExtension({
		includeTxHash: false,
		offerValiditySeconds: 60,
	});
}

// ── EIP-712 signing primitives keyed by X402_RECEIPT_SIGNING_KEY ─────────────

// Module-private SDK issuer. null when X402_RECEIPT_SIGNING_KEY is unset.
let _sdkIssuer = null;

function buildIssuer() {
	const raw = env.X402_RECEIPT_SIGNING_KEY;
	if (!raw) return null;

	const trimmed = raw.trim();
	const norm = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;

	// Validate length before passing to viem — a malformed key means the operator
	// intended to enable signing but mis-configured it. Throw loudly at boot.
	if (!/^0x[0-9a-fA-F]{64}$/.test(norm)) {
		throw new Error(
			'x402_receipt_signing_key_invalid: X402_RECEIPT_SIGNING_KEY must be a ' +
			'0x-prefixed 32-byte hex private key (64 hex chars after 0x). ' +
			'Generate with: node -e "console.log(require(\'viem/accounts\').generatePrivateKey())"',
		);
	}

	const account = privateKeyToAccount(norm);
	const signerAddress = account.address.toLowerCase();
	const kid = `did:pkh:eip155:1:${signerAddress}#key-1`;
	const signTypedData = (params) => account.signTypedData(params);

	_sdkIssuer = createEIP712OfferReceiptIssuer(kid, signTypedData);

	return { kid, signerAddress, sign: signTypedData };
}

/**
 * One singleton issuer per process. Resolves to the EIP-712 issuer when
 * X402_RECEIPT_SIGNING_KEY is set, otherwise null (feature disabled).
 * @type {{ kid: string, signerAddress: string, sign: Function } | null}
 */
export const issuer = buildIssuer();

/**
 * Sign one offer per accept entry on a 402 response. Returns the array of
 * signed offers in the wire shape consumed by extractOffersFromPaymentRequired
 * on the client side. Returns [] when the issuer is null (feature disabled).
 *
 * @param {{ accepts: object[], resourceUrl: string, validitySeconds?: number }} opts
 * @returns {Promise<object[]>}
 */
export async function signOffersForAccepts({ accepts, resourceUrl, validitySeconds = 60 }) {
	if (!_sdkIssuer) return [];
	const results = [];
	for (let i = 0; i < accepts.length; i++) {
		const a = accepts[i];
		results.push(
			await _sdkIssuer.issueOffer(resourceUrl, {
				acceptIndex: i,
				scheme: a.scheme,
				network: convertNetworkStringToCAIP2(a.network),
				asset: a.asset,
				payTo: a.payTo,
				amount: a.amount,
				offerValiditySeconds: validitySeconds,
			}),
		);
	}
	return results;
}

/**
 * Sign one receipt for a settled 200 response. Returns the signed receipt in
 * the wire shape consumed by extractReceiptFromResponse on the client side.
 * Returns null when the issuer is null (feature disabled) or when payer/network
 * are absent — a normal condition for endpoints whose settlement skipped the
 * facilitator (e.g. BSC `direct`).
 *
 * @param {{ resourceUrl: string, payer: string|null, network: string|null, txHash?: string, includeTxHash?: boolean }} opts
 * @returns {Promise<object|null>}
 */
export async function signReceipt({ resourceUrl, payer, network, txHash, includeTxHash = false }) {
	if (!_sdkIssuer) return null;
	if (payer == null || network == null) return null;
	return _sdkIssuer.issueReceipt(
		resourceUrl,
		payer,
		convertNetworkStringToCAIP2(network),
		includeTxHash ? txHash : undefined,
	);
}

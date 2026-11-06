// Server-side glue for the x402 Offer & Receipt extension.
//
// Our paid-endpoint plumbing (api/_lib/x402-paid-endpoint.js + x402-spec.js)
// is custom — it doesn't run the @x402/express ResourceServer that the SDK's
// createOfferReceiptExtension() hooks into. So instead of wiring extension
// hooks, we call the issuer directly here and emit the right
// `extensions["offer-receipt"]` shape ourselves. Wire shape matches the spec
// §4.1 (for 402 offers) and §5.1 (for 200 receipts).

import { OFFER_RECEIPT, convertNetworkStringToCAIP2 } from '@x402/extensions';

import { getIssuer } from './offer-receipt-issuer.js';

// Spec §4.1 — the offer-receipt info.offers[] meta-schema. Copied from
// @x402/extensions' internal OFFER_SCHEMA (it isn't exported as a constant)
// so this stays stable even if the SDK reshuffles modules.
const OFFER_SCHEMA = Object.freeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		offers: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					format: { type: 'string' },
					acceptIndex: { type: 'integer' },
					payload: {
						type: 'object',
						properties: {
							version: { type: 'integer' },
							resourceUrl: { type: 'string' },
							scheme: { type: 'string' },
							network: { type: 'string' },
							asset: { type: 'string' },
							payTo: { type: 'string' },
							amount: { type: 'string' },
							validUntil: { type: 'integer' },
						},
						required: ['version', 'resourceUrl', 'scheme', 'network', 'asset', 'payTo', 'amount'],
					},
					signature: { type: 'string' },
				},
				required: ['format', 'signature'],
			},
		},
	},
	required: ['offers'],
});

// Spec §5.1 — the offer-receipt info.receipt meta-schema. Same rationale as
// above for embedding rather than importing.
const RECEIPT_SCHEMA = Object.freeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		receipt: {
			type: 'object',
			properties: {
				format: { type: 'string' },
				payload: {
					type: 'object',
					properties: {
						version: { type: 'integer' },
						network: { type: 'string' },
						resourceUrl: { type: 'string' },
						payer: { type: 'string' },
						issuedAt: { type: 'integer' },
						transaction: { type: 'string' },
					},
					required: ['version', 'network', 'resourceUrl', 'payer', 'issuedAt'],
				},
				signature: { type: 'string' },
			},
			required: ['format', 'signature'],
		},
	},
	required: ['receipt'],
});

const DEFAULT_OFFER_VALIDITY_SEC = 300;

/**
 * Returns true when the issuer is configured. Callers use this to short-circuit
 * before doing extra work building offer inputs.
 */
export async function offerReceiptEnabled() {
	try {
		return Boolean(await getIssuer());
	} catch {
		// Fail-closed: a misconfigured issuer must not break the 402 dance.
		return false;
	}
}

function requirementToOfferInput(requirement, acceptIndex, offerValiditySeconds) {
	return {
		acceptIndex,
		scheme: requirement.scheme,
		network: convertNetworkStringToCAIP2(requirement.network),
		asset: requirement.asset,
		payTo: requirement.payTo,
		amount: requirement.amount,
		offerValiditySeconds: offerValiditySeconds ?? DEFAULT_OFFER_VALIDITY_SEC,
	};
}

/**
 * Build the `{ "offer-receipt": { info: { offers }, schema } }` extension
 * fragment for a 402 PaymentRequired body. Returns null when the issuer is
 * unconfigured OR when signing fails for every requirement (the protocol
 * still works without the extension; we never want it to break the 402 path).
 *
 * @param {string} resourceUrl - canonical URL the offer is for
 * @param {object[]} requirements - the `accepts[]` array (after Permit2 expansion)
 * @param {{ offerValiditySeconds?: number }} declaration
 */
export async function buildOffersExtension(resourceUrl, requirements, declaration = {}) {
	const built = await getIssuer().catch((err) => {
		console.error('[offer-receipt] issuer init failed:', err.message);
		return null;
	});
	if (!built) return null;
	const offers = [];
	for (let i = 0; i < requirements.length; i++) {
		try {
			const input = requirementToOfferInput(
				requirements[i],
				i,
				declaration.offerValiditySeconds,
			);
			const offer = await built.issuer.issueOffer(resourceUrl, input);
			offers.push(offer);
		} catch (err) {
			console.error(
				`[offer-receipt] failed to sign offer for accepts[${i}]: ${err.message}`,
			);
		}
	}
	if (!offers.length) return null;
	return {
		[OFFER_RECEIPT]: {
			info: { offers },
			schema: OFFER_SCHEMA,
		},
	};
}

/**
 * Build the `{ "offer-receipt": { info: { receipt }, schema } }` fragment for
 * a settled payment-response body. Returns null when the issuer is unconfigured
 * or when the settlement result lacks fields the spec requires (payer / network).
 *
 * `includeTxHash=false` (default) preserves privacy per spec §5.2; set true on
 * routes that feed reputation systems where on-chain verifiability matters more.
 *
 * Returns `{ extensionFragment, signedReceipt }` so the caller can persist the
 * receipt to the durable log alongside emitting it on the wire.
 *
 * @param {string} resourceUrl
 * @param {{ payer?: string, network?: string, transaction?: string }} settled
 * @param {{ includeTxHash?: boolean }} declaration
 */
export async function buildReceiptExtension(resourceUrl, settled, declaration = {}) {
	const built = await getIssuer().catch((err) => {
		console.error('[offer-receipt] issuer init failed:', err.message);
		return null;
	});
	if (!built) return null;
	if (!settled || !settled.payer || !settled.network) {
		console.warn('[offer-receipt] settled response missing payer/network; skipping receipt');
		return null;
	}
	const network = convertNetworkStringToCAIP2(settled.network);
	const includeTxHash = declaration.includeTxHash === true;
	const transaction = includeTxHash ? settled.transaction || undefined : undefined;
	let signedReceipt;
	try {
		signedReceipt = await built.issuer.issueReceipt(
			resourceUrl,
			settled.payer,
			network,
			transaction,
		);
	} catch (err) {
		console.error(`[offer-receipt] failed to sign receipt: ${err.message}`);
		return null;
	}
	return {
		extensionFragment: {
			[OFFER_RECEIPT]: {
				info: { receipt: signedReceipt },
				schema: RECEIPT_SCHEMA,
			},
		},
		signedReceipt,
	};
}

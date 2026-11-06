// Tests for the x402 Offer & Receipt extension (USE-17).
//
// Exercises the issuer + server modules without hitting the DB or the
// facilitator. We generate a throw-away EVM private key for the signer (so
// the dedicated-key safeguard passes), build offers + receipts, and verify
// the resulting artifacts round-trip through @x402/extensions verifiers.

import { describe, it, expect, beforeAll } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
	OFFER_RECEIPT,
	verifyOfferSignatureEIP712,
	verifyReceiptSignatureEIP712,
	verifyReceiptMatchesOffer,
	extractOfferPayload,
	extractReceiptPayload,
} from '@x402/extensions';

import { _resetIssuerForTests, getIssuer } from '../../api/_lib/x402/offer-receipt-issuer.js';
import {
	buildOffersExtension,
	buildReceiptExtension,
	offerReceiptEnabled,
} from '../../api/_lib/x402/offer-receipt-server.js';

const RESOURCE_URL = 'https://three.ws/api/x402/dance-tip';

const PAID_TO_REQUIREMENTS = [
	{
		scheme: 'exact',
		amount: '1000',
		network: 'eip155:8453',
		asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
		maxTimeoutSeconds: 60,
		resource: RESOURCE_URL,
	},
	{
		scheme: 'exact',
		amount: '1000',
		network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
		asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		payTo: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
		maxTimeoutSeconds: 60,
		resource: RESOURCE_URL,
	},
];

beforeAll(() => {
	// Dedicated signing key — distinct from any X402_PAY_TO_* envs in
	// .env.example. The issuer module asserts non-collision at boot.
	process.env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY = generatePrivateKey();
	process.env.OFFER_RECEIPT_FORMAT = 'eip712';
	_resetIssuerForTests();
});

describe('offer-receipt-issuer', () => {
	it('builds an EIP-712 issuer with did:pkh kid bound to the signer address', async () => {
		const built = await getIssuer();
		expect(built).toBeTruthy();
		expect(built.format).toBe('eip712');
		const expected = privateKeyToAccount(
			process.env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY,
		).address;
		expect(built.signerAddress).toBe(expected.toLowerCase());
		expect(built.kid).toBe(`did:pkh:eip155:1:${expected}#key-1`);
	});

	it('returns null when no signing key is configured', async () => {
		const savedKey = process.env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY;
		delete process.env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY;
		_resetIssuerForTests();
		try {
			const built = await getIssuer();
			expect(built).toBeNull();
			expect(await offerReceiptEnabled()).toBe(false);
		} finally {
			process.env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY = savedKey;
			_resetIssuerForTests();
		}
	});

	it('rejects a signing key that collides with X402_PAY_TO_BASE', async () => {
		const conflictKey = generatePrivateKey();
		const conflictAddr = privateKeyToAccount(conflictKey).address;
		const savedPayTo = process.env.X402_PAY_TO_BASE;
		const savedSignKey = process.env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY;
		process.env.X402_PAY_TO_BASE = conflictAddr;
		process.env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY = conflictKey;
		_resetIssuerForTests();
		try {
			await expect(getIssuer()).rejects.toThrow(/X402_PAY_TO_BASE/);
		} finally {
			process.env.X402_PAY_TO_BASE = savedPayTo;
			process.env.OFFER_RECEIPT_SIGNING_PRIVATE_KEY = savedSignKey;
			_resetIssuerForTests();
		}
	});
});

describe('buildOffersExtension', () => {
	it('signs one offer per accepts entry and wraps them in the spec envelope', async () => {
		const fragment = await buildOffersExtension(RESOURCE_URL, PAID_TO_REQUIREMENTS, {
			offerValiditySeconds: 600,
		});
		expect(fragment).toBeTruthy();
		const ext = fragment[OFFER_RECEIPT];
		expect(ext).toBeTruthy();
		expect(Array.isArray(ext.info.offers)).toBe(true);
		expect(ext.info.offers).toHaveLength(PAID_TO_REQUIREMENTS.length);
		expect(ext.schema).toMatchObject({ type: 'object', required: ['offers'] });

		// Each EIP-712 offer recovers to the configured signing address.
		const built = await getIssuer();
		for (let i = 0; i < ext.info.offers.length; i++) {
			const offer = ext.info.offers[i];
			expect(offer.format).toBe('eip712');
			expect(offer.acceptIndex).toBe(i);
			const verified = await verifyOfferSignatureEIP712(offer);
			expect(verified.signer.toLowerCase()).toBe(built.signerAddress);
			expect(verified.payload.resourceUrl).toBe(RESOURCE_URL);
			expect(verified.payload.payTo).toBe(PAID_TO_REQUIREMENTS[i].payTo);
		}
	});
});

describe('buildReceiptExtension + storage hand-off', () => {
	it('signs a receipt that matches the offer it pairs with', async () => {
		const offersFragment = await buildOffersExtension(RESOURCE_URL, PAID_TO_REQUIREMENTS, {});
		const offers = offersFragment[OFFER_RECEIPT].info.offers;
		const baseOffer = offers[0];
		const payerKey = generatePrivateKey();
		const payerAddress = privateKeyToAccount(payerKey).address;

		const built = await buildReceiptExtension(RESOURCE_URL, {
			payer: payerAddress,
			network: 'eip155:8453',
			transaction: '0xdeadbeef',
		}, { includeTxHash: false });
		expect(built).toBeTruthy();

		const receipt = built.extensionFragment[OFFER_RECEIPT].info.receipt;
		expect(receipt.format).toBe('eip712');

		const verified = await verifyReceiptSignatureEIP712(receipt);
		const issuer = await getIssuer();
		expect(verified.signer.toLowerCase()).toBe(issuer.signerAddress);
		expect(verified.payload.payer).toBe(payerAddress);
		expect(verified.payload.transaction).toBe(''); // privacy default

		const offerPayload = extractOfferPayload(baseOffer);
		const matches = verifyReceiptMatchesOffer(
			receipt,
			{ ...offerPayload, signedOffer: baseOffer, format: baseOffer.format, acceptIndex: 0 },
			[payerAddress],
		);
		expect(matches).toBe(true);
	});

	it('includes the on-chain tx hash when includeTxHash=true', async () => {
		const payerAddress = privateKeyToAccount(generatePrivateKey()).address;
		const built = await buildReceiptExtension(
			RESOURCE_URL,
			{ payer: payerAddress, network: 'eip155:8453', transaction: '0xabc123' },
			{ includeTxHash: true },
		);
		const receipt = built.extensionFragment[OFFER_RECEIPT].info.receipt;
		const payload = extractReceiptPayload(receipt);
		expect(payload.transaction).toBe('0xabc123');
	});

	it('returns null when settled response lacks payer/network', async () => {
		expect(
			await buildReceiptExtension(RESOURCE_URL, { network: 'eip155:8453' }, {}),
		).toBeNull();
		expect(
			await buildReceiptExtension(RESOURCE_URL, { payer: '0xabc' }, {}),
		).toBeNull();
	});
});

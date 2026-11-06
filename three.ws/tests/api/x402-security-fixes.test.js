// Regression tests for the x402 security audit fixes:
//
//   - verifyPayment EVM defense-in-depth: rejects underpayment (signed amount
//     below required) and wrong-recipient (signed `to` != payTo) BEFORE the
//     facilitator is consulted; accepts a correctly-signed payment.
//   - confirmSolanaPayment: statically decodes the signed SPL transfer and
//     flags underpayment / wrong recipient, passes a sufficient payment, and
//     stays inconclusive on an undecodable payload.
//   - constantTimeEquals: correct + no length-based early return.
//   - payment-identifier idempotency: a cache hit is bound to the signed
//     payment proof, so a reused id with a different/absent proof conflicts.

import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

// Mirror x402-spec.test.js: stub the heavy upstreams so importing the spec
// module is fast and deterministic. The real verify/settle logic still runs.
vi.mock('@coinbase/x402', () => ({
	createCdpAuthHeaders: vi.fn(async () => ({})),
}));
vi.mock('@x402/extensions', () => ({
	EIP2612_GAS_SPONSORING: { key: 'eip2612GasSponsoring' },
	ERC20_APPROVAL_GAS_SPONSORING: { key: 'erc20ApprovalGasSponsoring' },
	declareEip2612GasSponsoringExtension: () => ({ eip2612GasSponsoring: { info: {}, schema: {} } }),
	declareErc20ApprovalGasSponsoringExtension: () => ({ erc20ApprovalGasSponsoring: { info: {}, schema: {} } }),
}));
vi.mock('../../api/_lib/x402-bsc-direct.js', () => ({
	PAYMENT_EVENT_TOPIC: '0x' + 'a'.repeat(64),
	settleDirectPayment: vi.fn(async () => ({ success: true })),
	verifyDirectPayment: vi.fn(async () => ({ isValid: true })),
}));
vi.mock('../../api/_lib/x402-builder-code.js', () => ({
	BUILDER_CODE: 'three.ws',
	declareBuilderCodeExtension: () => ({ builderCode: { code: 'three.ws' } }),
	verifyClientEcho: vi.fn(() => true),
}));

vi.setConfig({ testTimeout: 15_000, hookTimeout: 60_000 });

const BASE = 'eip155:8453';
const PAY_TO_BASE = '0x4022de2d36c334e73c7a108805cea11c0564f402';

let spec;
beforeAll(async () => {
	spec = await import('../../api/_lib/x402-spec.js');
}, 60_000);

const ORIG_ENV = { ...process.env };
beforeEach(() => {
	process.env.X402_PAY_TO_BASE = PAY_TO_BASE;
	process.env.X402_ASSET_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
	process.env.X402_MAX_AMOUNT_REQUIRED = '1000';
	delete process.env.CDP_API_KEY_ID;
	delete process.env.CDP_API_KEY_SECRET;
});
afterEach(() => {
	for (const k of Object.keys(process.env)) if (!(k in ORIG_ENV)) delete process.env[k];
	Object.assign(process.env, ORIG_ENV);
	vi.restoreAllMocks();
});

function evmHeader({ value, to }) {
	const payload = {
		x402Version: 2,
		scheme: 'exact',
		network: BASE,
		payload: { authorization: { value: String(value), to } },
	};
	return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function baseRequirement() {
	return {
		scheme: 'exact',
		network: BASE,
		payTo: PAY_TO_BASE,
		asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		amount: '1000',
	};
}

describe('verifyPayment — EVM defense-in-depth', () => {
	const REAL_FETCH = global.fetch;
	afterEach(() => {
		global.fetch = REAL_FETCH;
	});

	it('rejects underpayment before calling the facilitator', async () => {
		const { verifyPayment } = spec;
		global.fetch = vi.fn();
		await expect(
			verifyPayment({
				paymentHeader: evmHeader({ value: 500, to: PAY_TO_BASE }),
				requirements: baseRequirement(),
				builderCode: null,
			}),
		).rejects.toMatchObject({ code: 'invalid_payment', status: 402 });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('rejects a payment signed to a different recipient', async () => {
		const { verifyPayment } = spec;
		global.fetch = vi.fn();
		await expect(
			verifyPayment({
				paymentHeader: evmHeader({ value: 1000, to: '0xdeadbeef00000000000000000000000000000000' }),
				requirements: baseRequirement(),
				builderCode: null,
			}),
		).rejects.toMatchObject({ code: 'invalid_payment', status: 402 });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('accepts a correctly-signed payment (amount + recipient) and consults the facilitator', async () => {
		const { verifyPayment } = spec;
		process.env.X402_FACILITATOR_URL_BASE = 'https://facilitator.test';
		process.env.X402_FACILITATOR_TOKEN_BASE = 'tok';
		global.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ isValid: true, payer: 'PAYER', network: BASE, asset: baseRequirement().asset }),
		}));
		const result = await verifyPayment({
			// to is compared case-insensitively
			paymentHeader: evmHeader({ value: 1500, to: PAY_TO_BASE.toUpperCase().replace('0X', '0x') }),
			requirements: baseRequirement(),
			builderCode: null,
		});
		expect(result.payer).toBe('PAYER');
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});
});

describe('confirmSolanaPayment — static SPL transfer decode', () => {
	let confirm;
	let web3;
	let splToken;
	const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

	beforeAll(async () => {
		confirm = await import('../../api/_lib/x402-solana-confirm.js');
		web3 = await import('@solana/web3.js');
		splToken = await import('@solana/spl-token');
	});

	function txPaying({ amount, payTo, mint = MINT, decimals = 6 }) {
		const { Keypair, PublicKey, TransactionMessage, VersionedTransaction } = web3;
		const {
			createTransferCheckedInstruction,
			getAssociatedTokenAddressSync,
			TOKEN_PROGRAM_ID,
			ASSOCIATED_TOKEN_PROGRAM_ID,
		} = splToken;
		const owner = Keypair.generate().publicKey;
		const mintPk = new PublicKey(mint);
		const payToPk = new PublicKey(payTo);
		const senderAta = getAssociatedTokenAddressSync(mintPk, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		const receiverAta = getAssociatedTokenAddressSync(mintPk, payToPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		const ix = createTransferCheckedInstruction(
			senderAta, mintPk, receiverAta, owner, amount, decimals, [], TOKEN_PROGRAM_ID,
		);
		const msg = new TransactionMessage({
			payerKey: owner,
			recentBlockhash: '11111111111111111111111111111111',
			instructions: [ix],
		}).compileToV0Message();
		const vtx = new VersionedTransaction(msg);
		return Buffer.from(vtx.serialize()).toString('base64');
	}

	const payTo = 'Cta6nRgbTuhM65E3g4UsEed6go9QHGoY75p5HPdHm3J4';

	it('confirms a payment that meets the required amount', () => {
		const tx = txPaying({ amount: 1000, payTo });
		const out = confirm.confirmSolanaPayment({
			paymentPayload: { payload: { transaction: tx } },
			requirement: { amount: '1000', asset: MINT, payTo },
		});
		expect(out.confirmed).toBe(true);
	});

	it('rejects an underpayment', () => {
		const tx = txPaying({ amount: 400, payTo });
		const out = confirm.confirmSolanaPayment({
			paymentPayload: { payload: { transaction: tx } },
			requirement: { amount: '1000', asset: MINT, payTo },
		});
		expect(out.confirmed).toBe(false);
	});

	it('rejects payment routed to a different recipient', () => {
		const tx = txPaying({ amount: 1000, payTo });
		const out = confirm.confirmSolanaPayment({
			paymentPayload: { payload: { transaction: tx } },
			requirement: { amount: '1000', asset: MINT, payTo: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' },
		});
		expect(out.confirmed).toBe(false);
	});

	it('stays inconclusive on an undecodable payload', () => {
		const out = confirm.confirmSolanaPayment({
			paymentPayload: { payload: { transaction: 'not-base64-decodable-as-a-tx' } },
			requirement: { amount: '1000', asset: MINT, payTo },
		});
		expect(out.inconclusive).toBe(true);
	});
});

describe('constantTimeEquals', () => {
	let constantTimeEquals;
	beforeAll(async () => {
		({ constantTimeEquals } = await import('../../api/_lib/crypto.js'));
	});

	it('returns true for equal strings, false for unequal', () => {
		expect(constantTimeEquals('s3cr3t-value', 's3cr3t-value')).toBe(true);
		expect(constantTimeEquals('s3cr3t-value', 's3cr3t-walue')).toBe(false);
	});

	it('returns false for differing lengths without throwing', () => {
		expect(constantTimeEquals('short', 'a-much-longer-secret')).toBe(false);
		expect(constantTimeEquals('', 'x')).toBe(false);
		expect(constantTimeEquals('x', '')).toBe(false);
	});
});

describe('payment-identifier idempotency — proof binding', () => {
	let mod;
	let cacheMod;
	const ROUTE = '/api/x402/test';

	beforeAll(async () => {
		process.env.X402_ALLOW_MEMORY_FALLBACK = '1';
		mod = await import('../../api/_lib/x402/payment-identifier-server.js');
		cacheMod = await import('../../api/_lib/x402/idempotency-cache.js');
	});
	beforeEach(() => {
		cacheMod._resetMemoryStore();
	});

	async function store(paymentHash) {
		await mod.storeResponse({
			route: ROUTE,
			paymentId: 'pay_known_id',
			payloadHash: 'reqhash',
			paymentHash,
			status: 200,
			body: 'PAID-CONTENT',
			contentType: 'application/json',
			paymentResponseHeader: 'resp',
		});
	}

	it('replays only to the same signed payment proof', async () => {
		await store('proofA');
		const hit = await mod.checkCache({ route: ROUTE, paymentId: 'pay_known_id', payloadHash: 'reqhash', paymentHash: 'proofA' });
		expect(hit.kind).toBe('hit');
		expect(hit.entry.body).toBe('PAID-CONTENT');
	});

	it('denies a reused id presented with a different proof', async () => {
		await store('proofA');
		const conflict = await mod.checkCache({ route: ROUTE, paymentId: 'pay_known_id', payloadHash: 'reqhash', paymentHash: 'proofB' });
		expect(conflict.kind).toBe('conflict');
		expect(conflict.reason).toBe('payment_proof_mismatch');
	});

	it('denies a reused id presented with no proof at all', async () => {
		await store('proofA');
		const conflict = await mod.checkCache({ route: ROUTE, paymentId: 'pay_known_id', payloadHash: 'reqhash', paymentHash: null });
		expect(conflict.kind).toBe('conflict');
		expect(conflict.reason).toBe('payment_proof_mismatch');
	});
});

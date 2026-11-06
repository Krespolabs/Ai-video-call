// USE-19: ERC-20 Approval Gas Sponsoring + USE-18: EIP-2612 Gas Sponsoring.
//
// Locks in `build402Body`'s behavior of advertising BOTH gas-sponsoring
// extensions at the top level whenever any accept entry opts into the Permit2
// asset-transfer method. Together, the two extensions cover the full ERC-20
// universe for gasless onboarding: EIP-2612 for tokens that implement
// `permit()`, ERC-20 approval as the universal fallback that signs a raw
// `approve(Permit2, MaxUint256)` tx for the facilitator to broadcast.
//
// Coverage:
//   • Permit2 sibling present → both extension keys advertised.
//   • Plain EIP-3009-only accept (no Permit2) → neither extension advertised.
//   • Per-route declarators emit the same extension keys (used by wk.js
//     discovery doc + x402-status surface).

import { beforeAll, describe, expect, it } from 'vitest';

import {
	EIP2612_EXTENSION_KEY,
	ERC20_APPROVAL_EXTENSION_KEY,
	build402Body,
	declareEip2612GasSponsoringExtension,
	declareErc20ApprovalGasSponsoringExtension,
	paymentRequirements,
	permit2VariantOf,
	NETWORK_BASE_MAINNET,
} from '../../api/_lib/x402-spec.js';

beforeAll(() => {
	// permit2VariantOf gates Permit2 sibling emission on CDP creds being
	// configured — set test values so the EVM accepts get a Permit2 sibling.
	process.env.CDP_API_KEY_ID = process.env.CDP_API_KEY_ID || 'test-cdp-key';
	process.env.CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET || 'test-cdp-secret';
	process.env.X402_PAY_TO_BASE =
		process.env.X402_PAY_TO_BASE || '0x4022de2d36c334e73c7a108805cea11c0564f402';
});

describe('build402Body — gas-sponsoring extension advertisement', () => {
	it('advertises both eip2612 + erc20-approval when a Permit2 accept is present', async () => {
		const accepts = paymentRequirements('https://three.ws/api/x402/example');
		const permit2 = accepts.find((a) => a?.extra?.assetTransferMethod === 'permit2');
		expect(permit2, 'expected paymentRequirements to emit a Permit2 sibling').toBeTruthy();

		const body = await build402Body({
			resourceUrl: 'https://three.ws/api/x402/example',
			accepts,
		});

		expect(body.extensions[EIP2612_EXTENSION_KEY]).toBeTruthy();
		expect(body.extensions[ERC20_APPROVAL_EXTENSION_KEY]).toBeTruthy();
	});

	it('does NOT advertise either extension when only EIP-3009 accepts are offered', async () => {
		const eip3009Only = {
			scheme: 'exact',
			network: NETWORK_BASE_MAINNET,
			amount: '1000',
			payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
			asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			maxTimeoutSeconds: 60,
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		};
		const body = await build402Body({
			resourceUrl: 'https://three.ws/api/x402/example',
			accepts: [eip3009Only],
		});

		expect(body.extensions[EIP2612_EXTENSION_KEY]).toBeUndefined();
		expect(body.extensions[ERC20_APPROVAL_EXTENSION_KEY]).toBeUndefined();
	});

	it('permit2VariantOf returns an accept whose Permit2 hint triggers both extensions', async () => {
		const base = {
			scheme: 'exact',
			network: NETWORK_BASE_MAINNET,
			amount: '1000',
			payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
			asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			maxTimeoutSeconds: 60,
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		};
		const sibling = permit2VariantOf(base);
		expect(sibling).toBeTruthy();
		expect(sibling.extra.assetTransferMethod).toBe('permit2');
		expect(sibling.extra.supportsEip2612).toBe(true);

		const body = await build402Body({
			resourceUrl: 'https://three.ws/api/x402/example',
			accepts: [base, sibling],
		});
		expect(body.extensions[EIP2612_EXTENSION_KEY]).toBeTruthy();
		expect(body.extensions[ERC20_APPROVAL_EXTENSION_KEY]).toBeTruthy();
	});
});

describe('per-route declarators emit the expected extension keys', () => {
	it('declareEip2612GasSponsoringExtension keys under EIP2612_EXTENSION_KEY', () => {
		const decl = declareEip2612GasSponsoringExtension();
		expect(decl[EIP2612_EXTENSION_KEY]).toBeTruthy();
	});

	it('declareErc20ApprovalGasSponsoringExtension keys under ERC20_APPROVAL_EXTENSION_KEY', () => {
		const decl = declareErc20ApprovalGasSponsoringExtension();
		expect(decl[ERC20_APPROVAL_EXTENSION_KEY]).toBeTruthy();
	});
});

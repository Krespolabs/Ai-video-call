// api/_lib/x402/pipelines/pay-by-name-resolver — classifyResolution unit tests.
// Pure function tests only: no network, no DB, no Redis required.

import { describe, it, expect } from 'vitest';

// We test classifyResolution in isolation. It only depends on @solana/web3.js
// (already installed) for on-curve validation — no mocks needed.
import { classifyResolution } from '../../api/_lib/x402/pipelines/pay-by-name-resolver.js';

// A real, well-known on-curve Solana address (USDC mint — stable canary).
const VALID_ADDR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// A second valid address for mismatch tests.
const OTHER_ADDR = 'So11111111111111111111111111111111111111112';

describe('classifyResolution', () => {
	it('verifies a well-formed SNS response with a valid on-curve address', () => {
		const body = { data: { address: VALID_ADDR, source: 'sns', resolved: 'threews.sol' } };
		const v = classifyResolution(body, { name: 'threews.sol' });
		expect(v.address).toBe(VALID_ADDR);
		expect(v.source).toBe('sns');
		expect(v.valid_address).toBe(true);
		expect(v.verified).toBe(true);
		expect(v.address_mismatch).toBe(false);
		expect(v.expected_address).toBeNull();
		expect(v.name).toBe('threews.sol');
	});

	it('verifies when address matches expected_address', () => {
		const body = { data: { address: VALID_ADDR, source: 'sns', resolved: 'threews.sol' } };
		const v = classifyResolution(body, { name: 'threews.sol', expectedAddress: VALID_ADDR });
		expect(v.verified).toBe(true);
		expect(v.address_mismatch).toBe(false);
		expect(v.expected_address).toBe(VALID_ADDR);
	});

	it('flags address_mismatch when resolved address ≠ expectedAddress', () => {
		const body = { data: { address: OTHER_ADDR, source: 'sns', resolved: 'threews.sol' } };
		const v = classifyResolution(body, { name: 'threews.sol', expectedAddress: VALID_ADDR });
		expect(v.verified).toBe(false);
		expect(v.address_mismatch).toBe(true);
		expect(v.address).toBe(OTHER_ADDR);
		expect(v.expected_address).toBe(VALID_ADDR);
	});

	it('returns unverified on null body (fetch / network failure)', () => {
		const v = classifyResolution(null, { name: 'threews.sol' });
		expect(v.verified).toBe(false);
		expect(v.valid_address).toBe(false);
		expect(v.address).toBeNull();
		expect(v.source).toBeNull();
	});

	it('returns unverified when body has no data field', () => {
		const v = classifyResolution({ error: 'not_found' }, { name: 'threews.sol' });
		expect(v.verified).toBe(false);
		expect(v.address).toBeNull();
	});

	it('returns unverified for a non-base58 / garbage address', () => {
		const body = { data: { address: 'not-a-wallet', source: 'sns', resolved: 'threews.sol' } };
		const v = classifyResolution(body, { name: 'threews.sol' });
		expect(v.valid_address).toBe(false);
		expect(v.verified).toBe(false);
		expect(v.address).toBe('not-a-wallet');
	});


	it('resolves name from response when opts.name is absent', () => {
		const body = { data: { address: VALID_ADDR, source: 'username', resolved: '@threews' } };
		const v = classifyResolution(body);
		expect(v.name).toBe('@threews');
		expect(v.verified).toBe(true);
	});
});

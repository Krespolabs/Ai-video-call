// Unit tests for the marketplace platform-fee math + fail-safe config.
//
// Pure logic — no DB, no RPC. Verifies the fee ships INERT (0 bps by default),
// activates only when both a rate and a treasury wallet are configured, splits
// the price correctly, and is clamped to a sane ceiling.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Re-import the module fresh each time so its module-level recipient cache does
// not leak env-derived state between cases. vi.resetModules() clears the module
// registry; the static import path keeps it statically analyzable for Vite.
const FRESH = async () => {
	vi.resetModules();
	return import('../../api/_lib/marketplace-platform-fee.js');
};

const ENV_KEYS = [
	'MARKETPLACE_PLATFORM_FEE_BPS',
	'MARKETPLACE_PLATFORM_FEE_WALLET',
	'PLATFORM_TREASURY_KEYPAIR',
	'TREASURY_KEYPAIR',
];

describe('marketplace-platform-fee', () => {
	let saved;
	beforeEach(() => {
		saved = {};
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('defaults to 0 bps (fee OFF) with no env set', async () => {
		const m = await FRESH();
		expect(m.marketplaceFeeBps()).toBe(0);
	});

	it('reads the configured rate and clamps to the ceiling', async () => {
		process.env.MARKETPLACE_PLATFORM_FEE_BPS = '500';
		let m = await FRESH();
		expect(m.marketplaceFeeBps()).toBe(500);

		process.env.MARKETPLACE_PLATFORM_FEE_BPS = '99999';
		m = await FRESH();
		expect(m.marketplaceFeeBps()).toBe(m.MAX_FEE_BPS);

		process.env.MARKETPLACE_PLATFORM_FEE_BPS = '-5';
		m = await FRESH();
		expect(m.marketplaceFeeBps()).toBe(0);
	});

	it('computes floor(gross * bps / 10000) atomics', async () => {
		const m = await FRESH();
		// 5% of 1.000000 USDC = 0.05 USDC = 50_000 atomics
		expect(m.marketplaceFeeAtomics(1_000_000n, 500)).toBe(50_000n);
		// floor: 5% of 1 atomic = 0
		expect(m.marketplaceFeeAtomics(1n, 500)).toBe(0n);
		// 0 bps → 0
		expect(m.marketplaceFeeAtomics(1_000_000n, 0)).toBe(0n);
		// string input tolerated
		expect(m.marketplaceFeeAtomics('2000000', 250)).toBe(50_000n);
	});

	it('resolveMarketplaceFee returns null when no rate is set', async () => {
		process.env.MARKETPLACE_PLATFORM_FEE_WALLET = 'THREEsynthetic11111111111111111111111111111';
		const m = await FRESH();
		expect(await m.resolveMarketplaceFee({ grossAtomics: 1_000_000n })).toBeNull();
	});

	it('resolveMarketplaceFee returns null when rate is set but no treasury configured', async () => {
		process.env.MARKETPLACE_PLATFORM_FEE_BPS = '500';
		const m = await FRESH();
		expect(await m.resolveMarketplaceFee({ grossAtomics: 1_000_000n })).toBeNull();
	});

	it('resolveMarketplaceFee splits the price when both rate + wallet are set', async () => {
		process.env.MARKETPLACE_PLATFORM_FEE_BPS = '500';
		// A valid base58 pubkey (System Program id) — only its format matters here.
		process.env.MARKETPLACE_PLATFORM_FEE_WALLET = '11111111111111111111111111111111';
		const m = await FRESH();
		const fee = await m.resolveMarketplaceFee({ grossAtomics: 1_000_000n });
		expect(fee).not.toBeNull();
		expect(fee.bps).toBe(500);
		expect(fee.feeAtomics).toBe(50_000n);
		expect(fee.recipient.toBase58()).toBe('11111111111111111111111111111111');
		// creator leg = gross - fee
		expect(1_000_000n - fee.feeAtomics).toBe(950_000n);
	});
});

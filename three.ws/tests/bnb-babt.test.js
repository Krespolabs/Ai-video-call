/**
 * BABT (Binance Account Bound Token) holder-check lib — unit tests.
 *
 * `hasBabt` is exercised with an injected mock viem client (deterministic, no
 * live network) for every code path: holder, non-holder, tokenIdOf failure,
 * and a hard contract-read failure. One opt-in live test (BNB_LIVE_RPC=1)
 * re-proves the real mainnet holder captured in docs/bnb-babt-findings.md —
 * found by scanning real Transfer/mint logs on the real BABT contract.
 *
 * Endpoint tests live in tests/bnb-babt-check-endpoint.test.js — kept in a
 * separate file because that suite mocks `../api/_lib/bnb/babt.js` itself
 * (vi.mock is hoisted per-file, so it would otherwise shadow the real
 * `hasBabt` these lib tests exercise directly).
 */

import { describe, it, expect } from 'vitest';
import { hasBabt, BabtCheckError, BABT_CONTRACTS } from '../api/_lib/bnb/babt.js';

const HOLDER = '0x04d1C36842430A169D132ADa68006e6Bb9E3808b';
const NON_HOLDER = '0x000000000000000000000000000000000000dEaD';

function mockClient({ balance, tokenId, failBalance, failTokenId }) {
	return {
		async readContract({ functionName }) {
			if (functionName === 'balanceOf') {
				if (failBalance) throw new Error('rpc timeout');
				return balance;
			}
			if (functionName === 'tokenIdOf') {
				if (failTokenId) throw new Error('tokenIdOf reverted');
				return tokenId;
			}
			throw new Error(`unexpected functionName ${functionName}`);
		},
	};
}

describe('BABT_CONTRACTS', () => {
	it('matches the addresses confirmed real in docs/bnb-babt-findings.md', () => {
		expect(BABT_CONTRACTS.bscMainnet).toBe('0x2B09d47D550061f995A3b5C6F0Fd58005215D7c8');
		expect(BABT_CONTRACTS.bscTestnet).toBe('0x984E6a7b9cb73cB7884c9ca9b1Ee625546F9D0E3');
	});
});

describe('hasBabt', () => {
	it('maps balanceOf > 0 to holdsBabt:true and resolves tokenIdOf', async () => {
		const client = mockClient({ balance: 1n, tokenId: 1316815n });
		const out = await hasBabt(HOLDER, 'bscMainnet', { client });
		expect(out.holdsBabt).toBe(true);
		expect(out.tokenId).toBe('1316815');
		expect(out.network).toBe('bscMainnet');
		expect(out.contract).toBe(BABT_CONTRACTS.bscMainnet);
		expect(typeof out.checkedAt).toBe('string');
	});

	it('maps balanceOf = 0 to holdsBabt:false and does not call tokenIdOf', async () => {
		const client = mockClient({ balance: 0n, failTokenId: true }); // would throw if called
		const out = await hasBabt(NON_HOLDER, 'bscMainnet', { client });
		expect(out.holdsBabt).toBe(false);
		expect(out.tokenId).toBeNull();
	});

	it('a tokenIdOf failure after a confirmed holder does not downgrade holdsBabt', async () => {
		const client = mockClient({ balance: 1n, failTokenId: true });
		const out = await hasBabt(HOLDER, 'bscMainnet', { client });
		expect(out.holdsBabt).toBe(true);
		expect(out.tokenId).toBeNull();
	});

	it('a balanceOf read failure throws a typed BabtCheckError', async () => {
		const client = mockClient({ failBalance: true });
		await expect(hasBabt(HOLDER, 'bscMainnet', { client })).rejects.toBeInstanceOf(BabtCheckError);
	});

	it('rejects a syntactically invalid address before any network call', async () => {
		await expect(hasBabt('not-an-address')).rejects.toBeInstanceOf(TypeError);
	});

	it('rejects a Solana address (wrong chain format)', async () => {
		await expect(hasBabt('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump')).rejects.toBeInstanceOf(TypeError);
	});

	it('defaults to mainnet when network is omitted', async () => {
		const client = mockClient({ balance: 0n });
		const out = await hasBabt(NON_HOLDER, undefined, { client });
		expect(out.network).toBe('bscMainnet');
	});

	it('resolves the testnet contract when network is bscTestnet', async () => {
		const client = mockClient({ balance: 0n });
		const out = await hasBabt(NON_HOLDER, 'bscTestnet', { client });
		expect(out.network).toBe('bscTestnet');
		expect(out.contract).toBe(BABT_CONTRACTS.bscTestnet);
	});

	// Opt-in live smoke test — re-proves the real mint found in
	// docs/bnb-babt-findings.md against the real mainnet contract.
	const liveTest = process.env.BNB_LIVE_RPC ? it : it.skip;
	liveTest('real mainnet holder balanceOf/tokenIdOf (live RPC)', async () => {
		const out = await hasBabt(HOLDER, 'bscMainnet');
		expect(out.holdsBabt).toBe(true);
		expect(out.tokenId).toBeTruthy();
	}, 20000);
});

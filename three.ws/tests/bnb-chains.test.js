/**
 * BNB chain foundation lib — unit tests.
 *
 * Address constants are asserted verbatim against 00-CONTEXT. RPC failover and
 * probeBlockTime are exercised with injected/mocked transports so the suite is
 * deterministic (no live network). One live smoke test is guarded behind
 * BNB_LIVE_RPC for opt-in real-RPC verification.
 */

import { describe, it, expect } from 'vitest';
import { custom } from 'viem';
import {
	BNB_CHAINS,
	BnbRpcError,
	getPublicClient,
	probeBlockTime,
	isEvmAddress,
	assertBscAddress,
} from '../api/_lib/bnb/chains.js';

describe('BNB_CHAINS constants', () => {
	it('mainnet Greenfield crossChain hub matches 00-CONTEXT verbatim', () => {
		expect(BNB_CHAINS.bscMainnet.greenfieldHubs.crossChain).toBe(
			'0x77e719b714be09F70D484AB81F70D02B0E182f7d',
		);
		expect(BNB_CHAINS.bscMainnet.greenfieldHubs.multiMessage).toBe(
			'0x26204702935e2D617EE75B795152B9623a7d9809',
		);
	});

	it('has >=2 RPCs per network for failover', () => {
		expect(BNB_CHAINS.bscMainnet.rpcs.length).toBeGreaterThanOrEqual(2);
		expect(BNB_CHAINS.bscTestnet.rpcs.length).toBeGreaterThanOrEqual(2);
	});

	it('mainnet is 56, testnet is 97', () => {
		expect(BNB_CHAINS.bscMainnet.id).toBe(56);
		expect(BNB_CHAINS.bscTestnet.id).toBe(97);
	});
});

describe('isEvmAddress / assertBscAddress', () => {
	it('accepts a valid 0x 20-byte address', () => {
		expect(isEvmAddress('0x77e719b714be09F70D484AB81F70D02B0E182f7d')).toBe(true);
	});

	it('rejects a Solana base58 mint and junk', () => {
		expect(isEvmAddress('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump')).toBe(false);
		expect(isEvmAddress('not-an-address')).toBe(false);
		expect(isEvmAddress('0x123')).toBe(false);
		expect(isEvmAddress(null)).toBe(false);
	});

	it('assertBscAddress returns a checksummed address', () => {
		const out = assertBscAddress('0x77e719b714be09f70d484ab81f70d02b0e182f7d');
		expect(out).toBe('0x77e719b714be09F70D484AB81F70D02B0E182f7d');
	});

	it('assertBscAddress throws on a Solana address', () => {
		expect(() => assertBscAddress('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump')).toThrow(TypeError);
	});
});

describe('getPublicClient failover', () => {
	it('advances to the second transport when the first throws', async () => {
		const t1 = custom({
			async request() {
				throw new Error('rpc-1 down');
			},
		});
		const t2 = custom({
			async request({ method }) {
				if (method === 'eth_blockNumber') return '0x2a'; // 42
				return null;
			},
		});
		const client = getPublicClient('bscTestnet', { transports: [t1, t2] });
		const bn = await client.getBlockNumber();
		expect(bn).toBe(42n);
	});
});

describe('probeBlockTime', () => {
	it('computes avgBlockTimeMs from a mocked block pair (deterministic)', async () => {
		// latest #1000 @ t=1450s, older #800 @ t=1360s → 200 blocks / 90s = 450ms/block.
		const fakeClient = {
			bnbRpcs: ['mock'],
			async getBlock({ blockTag }) {
				if (blockTag === 'latest') return { number: 1000n, timestamp: 1450n };
				return { number: 800n, timestamp: 1360n };
			},
		};
		const out = await probeBlockTime('bscMainnet', 200, { client: fakeClient });
		expect(out.avgBlockTimeMs).toBe(450);
		expect(out.latestBlock).toBe(1000);
		expect(out.sampleBlocks).toBe(200);
		expect(out.target).toBe(450);
		expect(typeof out.measuredAt).toBe('string');
	});

	it('testnet probe reports target=null', async () => {
		const fakeClient = {
			bnbRpcs: ['mock'],
			async getBlock({ blockTag }) {
				if (blockTag === 'latest') return { number: 500n, timestamp: 1000n };
				return { number: 300n, timestamp: 910n };
			},
		};
		const out = await probeBlockTime('bscTestnet', 200, { client: fakeClient });
		expect(out.target).toBeNull();
	});

	it('throws BnbRpcError listing tried URLs when all RPCs fail', async () => {
		await expect(
			probeBlockTime('bscTestnet', 10, { rpcs: ['http://127.0.0.1:1/dead'], timeoutMs: 300 }),
		).rejects.toMatchObject({ name: 'BnbRpcError' });
	});

	// Opt-in live smoke test — asserts the 0.45s claim holds on mainnet today.
	const liveTest = process.env.BNB_LIVE_RPC ? it : it.skip;
	liveTest('mainnet avg block time < 700ms (live RPC)', async () => {
		const out = await probeBlockTime('bscMainnet', 200);
		expect(out.avgBlockTimeMs).toBeGreaterThan(0);
		expect(out.avgBlockTimeMs).toBeLessThan(700);
	}, 20000);
});

describe('BnbRpcError', () => {
	it('carries the tried URL list', () => {
		const e = new BnbRpcError('boom', { network: 'bscTestnet', tried: ['a', 'b'] });
		expect(e.name).toBe('BnbRpcError');
		expect(e.tried).toEqual(['a', 'b']);
	});
});

/**
 * Browser gasless move sender (src/bnb/move-sender.js) — unit tests.
 *
 * Pure engine-unit conversion (meters → int32 millimeters, radians → uint16
 * centidegrees, bounds check) plus `createMoveSender`'s dedupe/coalescing
 * behaviour, exercised with an injected fake `account`/mocked MegaFuel RPC —
 * no network, no DOM.
 */

import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createMoveSender, toContractPos, toContractFacing, isWithinWorldMovesRange, COORD_SCALE } from '../src/bnb/move-sender.js';
import { COORD_MAX } from '../api/_lib/bnb/world-moves.js';

const WORLD_MOVES_ADDR = '0x71Ddcb9865632Ca3c4325dE0E4a92Cc0065c8aaE'; // anvil-fork proof address (DEPLOYMENTS.md) — test fixture only
const account = privateKeyToAccount(generatePrivateKey());

/** Flush the fire-and-forget send chain (createMoveSender.updatePosition never returns a promise, by design — "never freeze the game"). */
function flushAsync() {
	return new Promise((resolve) => setTimeout(resolve, 10));
}

function mockPublicClient() {
	return {
		chain: { id: 97, name: 'BNB Smart Chain Testnet', nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 } },
		bnbRpcs: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
		async getTransactionCount() {
			return 0;
		},
		async estimateGas() {
			return 30000n;
		},
	};
}

describe('toContractPos', () => {
	it('scales meters to millimeters (COORD_SCALE=1000) and rounds', () => {
		expect(toContractPos({ x: 1.2345, y: -0.5, z: 0 })).toEqual({ x: 1235, y: -500, z: 0 });
		expect(COORD_SCALE).toBe(1000);
	});
});

describe('toContractFacing', () => {
	it('converts 0 radians to 0 centidegrees', () => {
		expect(toContractFacing(0)).toBe(0);
	});
	it('converts pi radians to 18000 centidegrees (180.00°)', () => {
		expect(toContractFacing(Math.PI)).toBe(18000);
	});
	it('wraps negative radians into [0, 2π) before converting', () => {
		expect(toContractFacing(-Math.PI / 2)).toBe(27000);
	});
	it('wraps a full turn (2π) back to 0, never 36000 (out of uint16 contract convention)', () => {
		expect(toContractFacing(2 * Math.PI)).toBe(0);
	});
});

describe('isWithinWorldMovesRange', () => {
	it('accepts an ordinary in-scene position', () => {
		expect(isWithinWorldMovesRange({ x: 10, y: 0, z: -5 })).toBe(true);
	});
	it('rejects a position whose millimeter-scaled coordinate exceeds COORD_MAX', () => {
		const metersJustOver = (COORD_MAX + 1) / COORD_SCALE;
		expect(isWithinWorldMovesRange({ x: metersJustOver, y: 0, z: 0 })).toBe(false);
	});
});

describe('createMoveSender', () => {
	it('does nothing until updatePosition is called', () => {
		const sender = createMoveSender({ account, worldId: 1, address: WORLD_MOVES_ADDR, publicClient: mockPublicClient() });
		expect(sender.stats).toMatchObject({ sent: 0, inFlight: false });
	});

	it('sends a sponsored move on the first updatePosition call', async () => {
		const sent = [];
		const sender = createMoveSender({
			account,
			worldId: 1,
			address: WORLD_MOVES_ADDR,
			publicClient: mockPublicClient(),
			onSent: (r) => sent.push(r),
			megafuelRpc: async (method) => {
				if (method === 'pm_isSponsorable') return { sponsorable: true };
				if (method === 'eth_sendRawTransaction') return '0x' + 'e'.repeat(64);
				throw new Error(`unexpected ${method}`);
			},
		});
		sender.updatePosition({ x: 1, y: 0, z: 2 }, 0);
		await flushAsync();
		expect(sent).toEqual([{ hash: '0x' + 'e'.repeat(64), mode: 'sponsored', sponsor: { sponsorable: true } }]);
		expect(sender.stats.sent).toBe(1);
	});

	it('skips a resubmit when the quantized position/facing is unchanged (stationary player)', async () => {
		let calls = 0;
		const sender = createMoveSender({
			account,
			worldId: 1,
			address: WORLD_MOVES_ADDR,
			publicClient: mockPublicClient(),
			megafuelRpc: async (method) => {
				calls++;
				if (method === 'pm_isSponsorable') return { sponsorable: true };
				return '0x' + 'f'.repeat(64);
			},
		});
		sender.updatePosition({ x: 1, y: 0, z: 2 }, 0);
		await flushAsync();
		const callsAfterFirst = calls;
		// Same position/facing (well under millimeter precision) — must NOT trigger a second send.
		sender.updatePosition({ x: 1.0000001, y: 0, z: 2 }, 0);
		await flushAsync();
		expect(calls).toBe(callsAfterFirst);
		expect(sender.stats.sent).toBe(1);
	});

	it('silently drops an out-of-range position instead of firing a doomed tx', async () => {
		let calls = 0;
		const sender = createMoveSender({
			account,
			worldId: 1,
			address: WORLD_MOVES_ADDR,
			publicClient: mockPublicClient(),
			megafuelRpc: async () => {
				calls++;
				return { sponsorable: true };
			},
		});
		sender.updatePosition({ x: 1e12, y: 0, z: 0 }, 0);
		await Promise.resolve();
		expect(calls).toBe(0);
		expect(sender.stats.sent).toBe(0);
	});

	it('stop() halts further sends', async () => {
		let calls = 0;
		const sender = createMoveSender({
			account,
			worldId: 1,
			address: WORLD_MOVES_ADDR,
			publicClient: mockPublicClient(),
			megafuelRpc: async (method) => {
				calls++;
				if (method === 'pm_isSponsorable') return { sponsorable: true };
				return '0x' + 'a'.repeat(64);
			},
		});
		sender.updatePosition({ x: 1, y: 0, z: 0 }, 0);
		await flushAsync();
		sender.stop();
		const callsAfterStop = calls;
		sender.updatePosition({ x: 5, y: 0, z: 0 }, 0);
		await flushAsync();
		expect(calls).toBe(callsAfterStop);
	});
});

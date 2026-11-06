/**
 * WorldMoves gasless move sender (api/_lib/bnb/world-moves.js) — unit tests.
 *
 * `buildMoveTx` calldata is checked byte-for-byte against a hand-decoded
 * expectation. `MoveCoalescer` is exercised as pure logic — a controllable
 * deferred `sendFn`, no network, no timers — feeding it a burst of positions
 * faster than a "confirmation" resolves and asserting only the latest input
 * survives per in-flight cycle. `sendMove` reuses the same
 * megafuelRpc/publicClient injection pattern tests/bnb-megafuel.test.js
 * already proved, so the sponsored + self-pay + decline paths are exercised
 * for real (no live network).
 */

import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
	buildMoveTx,
	buildJoinTx,
	buildLeaveTx,
	buildCheckpointTx,
	sendMove,
	sendJoin,
	sendLeave,
	worldMovesAddress,
	WorldMovesError,
	MoveCoalescer,
	WORLD_MOVES_ABI,
	COORD_MIN,
	COORD_MAX,
} from '../api/_lib/bnb/world-moves.js';

const WORLD_MOVES_ADDR = '0x71Ddcb9865632Ca3c4325dE0E4a92Cc0065c8aaE'; // anvil-fork proof address (DEPLOYMENTS.md) — test fixture only
const account = privateKeyToAccount(generatePrivateKey());

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

describe('worldMovesAddress', () => {
	it('returns opts.address when given, bypassing env config entirely', () => {
		expect(worldMovesAddress('bscTestnet', { address: WORLD_MOVES_ADDR })).toBe(WORLD_MOVES_ADDR);
	});

	it('throws a typed WorldMovesError when no address is configured or passed', () => {
		expect(() => worldMovesAddress('bscTestnet')).toThrow(WorldMovesError);
		try {
			worldMovesAddress('bscMainnet');
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(WorldMovesError);
			expect(err.code).toBe('no_deployment');
			expect(err.message).toContain('WORLD_MOVES_ADDRESS_MAINNET');
		}
	});
});

describe('buildMoveTx', () => {
	it('encodes the right calldata for known args', () => {
		const tx = buildMoveTx(1, { x: 10, y: -5, z: 3 }, 36, { address: WORLD_MOVES_ADDR });
		expect(tx.to).toBe(WORLD_MOVES_ADDR);
		expect(tx.value).toBe(0n);
		const decoded = decodeFunctionData({ abi: WORLD_MOVES_ABI, data: tx.data });
		expect(decoded.functionName).toBe('move');
		expect(decoded.args).toEqual([1, 10, -5, 3, 36]);
	});

	it('round-trips coordinate extremes (COORD_MIN/COORD_MAX) without reverting client-side', () => {
		const tx = buildMoveTx(1, { x: COORD_MIN, y: COORD_MAX, z: 0 }, 0, { address: WORLD_MOVES_ADDR });
		const decoded = decodeFunctionData({ abi: WORLD_MOVES_ABI, data: tx.data });
		expect(decoded.args).toEqual([1, COORD_MIN, COORD_MAX, 0, 0]);
	});

	it('rejects an out-of-bounds coordinate before ever building calldata', () => {
		expect(() => buildMoveTx(1, { x: COORD_MAX + 1, y: 0, z: 0 }, 0, { address: WORLD_MOVES_ADDR })).toThrow(WorldMovesError);
		expect(() => buildMoveTx(1, { x: COORD_MIN - 1, y: 0, z: 0 }, 0, { address: WORLD_MOVES_ADDR })).toThrow(/coord_out_of_bounds|bounds/);
	});

	it('rejects a facing outside uint16 range', () => {
		expect(() => buildMoveTx(1, { x: 0, y: 0, z: 0 }, 65536, { address: WORLD_MOVES_ADDR })).toThrow(WorldMovesError);
		expect(() => buildMoveTx(1, { x: 0, y: 0, z: 0 }, -1, { address: WORLD_MOVES_ADDR })).toThrow(WorldMovesError);
	});

	it('rejects a non-uint32 worldId', () => {
		expect(() => buildMoveTx(-1, { x: 0, y: 0, z: 0 }, 0, { address: WORLD_MOVES_ADDR })).toThrow(WorldMovesError);
		expect(() => buildMoveTx(1.5, { x: 0, y: 0, z: 0 }, 0, { address: WORLD_MOVES_ADDR })).toThrow(WorldMovesError);
	});
});

describe('buildJoinTx / buildLeaveTx / buildCheckpointTx', () => {
	it('encode join() and leave() with just the worldId', () => {
		const join = buildJoinTx(7, { address: WORLD_MOVES_ADDR });
		expect(decodeFunctionData({ abi: WORLD_MOVES_ABI, data: join.data })).toMatchObject({ functionName: 'join', args: [7] });
		const leave = buildLeaveTx(7, { address: WORLD_MOVES_ADDR });
		expect(decodeFunctionData({ abi: WORLD_MOVES_ABI, data: leave.data })).toMatchObject({ functionName: 'leave', args: [7] });
	});

	it('encodes checkpoint() identically shaped to move()', () => {
		const cp = buildCheckpointTx(7, { x: 1, y: 2, z: 3 }, 100, { address: WORLD_MOVES_ADDR });
		const decoded = decodeFunctionData({ abi: WORLD_MOVES_ABI, data: cp.data });
		expect(decoded.functionName).toBe('checkpoint');
		expect(decoded.args).toEqual([7, 1, 2, 3, 100]);
	});
});

describe('MoveCoalescer — pure logic, no network', () => {
	/** A send fn whose resolution is controlled externally, to simulate "slower than the caller's update rate". */
	function deferredSend(log) {
		let resolvers = [];
		const send = (input) => {
			log.push(input);
			return new Promise((resolve) => resolvers.push(() => resolve({ hash: `0x${log.length}`, mode: 'sponsored' })));
		};
		return { send, resolveNext: () => resolvers.shift()?.() };
	}

	it('launches the first submit immediately (no artificial delay)', async () => {
		const log = [];
		const { send } = deferredSend(log);
		const c = new MoveCoalescer(send);
		c.submit('a');
		await Promise.resolve();
		expect(log).toEqual(['a']);
		expect(c.stats.inFlight).toBe(true);
	});

	it('a burst of submits while one send is in flight collapses to latest-wins, coalescing the rest', async () => {
		const log = [];
		const { send, resolveNext } = deferredSend(log);
		const c = new MoveCoalescer(send);

		c.submit(1); // launches immediately
		await Promise.resolve();
		c.submit(2); // queued (pending=2)
		c.submit(3); // 2 is dropped (coalesced), pending=3
		c.submit(4); // 3 is dropped (coalesced), pending=4

		expect(c.stats.coalesced).toBe(2);
		expect(c.stats.hasPending).toBe(true);
		expect(log).toEqual([1]); // only the first send has actually been launched so far

		resolveNext(); // 1 resolves → launches the latest pending (4), NOT 2 or 3
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual([1, 4]);

		resolveNext(); // 4 resolves → nothing pending, coalescer goes idle
		await Promise.resolve();
		expect(c.stats).toMatchObject({ sent: 2, coalesced: 2, inFlight: false, hasPending: false });
	});

	it('never exceeds one in-flight send at a time under a sustained burst', async () => {
		const log = [];
		const { send, resolveNext } = deferredSend(log);
		const c = new MoveCoalescer(send);
		for (let i = 0; i < 50; i++) c.submit(i);
		expect(log.length).toBe(1); // only the very first submit actually launched
		expect(c.stats.inFlight).toBe(true);
		resolveNext();
		await Promise.resolve();
		await Promise.resolve();
		expect(log.length).toBe(2); // resolving launches exactly one more — the latest (49)
		expect(log[1]).toBe(49);
		expect(c.stats.coalesced).toBe(48);
	});

	it('a failed send is reported via onError and does not wedge the coalescer', async () => {
		const errors = [];
		const sent = [];
		let calls = 0;
		const c = new MoveCoalescer(
			async (input) => {
				calls++;
				if (calls === 1) throw new Error('megafuel declined');
				return { hash: '0xok', mode: 'self-pay' };
			},
			{ onError: (err, input) => errors.push([err.message, input]), onSent: (result, input) => sent.push([result, input]) },
		);
		c.submit('a');
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toEqual([['megafuel declined', 'a']]);
		c.submit('b');
		await Promise.resolve();
		await Promise.resolve();
		expect(sent).toEqual([[{ hash: '0xok', mode: 'self-pay' }, 'b']]);
		expect(c.stats).toMatchObject({ sent: 1, errors: 1 });
	});

	it('dispose() stops launching further sends but lets an in-flight one settle', async () => {
		const log = [];
		const { send, resolveNext } = deferredSend(log);
		const c = new MoveCoalescer(send);
		c.submit(1);
		await Promise.resolve();
		c.submit(2);
		c.dispose();
		resolveNext();
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual([1]); // 2 never launches — disposed before it could
		expect(c.stats.sent).toBe(1);
		c.submit(3);
		expect(log).toEqual([1]); // submit() after dispose() is a no-op
	});

	it('rejects a non-function sendFn', () => {
		expect(() => new MoveCoalescer(null)).toThrow(WorldMovesError);
	});
});

describe('sendMove / sendJoin / sendLeave — sponsored + self-pay + decline (mocked MegaFuel + RPC)', () => {
	it('sendMove returns mode:"sponsored" when MegaFuel accepts the probe', async () => {
		const result = await sendMove(
			{ account, worldId: 1, pos: { x: 10, y: -5, z: 3 }, facing: 36, network: 'bscTestnet' },
			{
				address: WORLD_MOVES_ADDR,
				publicClient: mockPublicClient(),
				megafuelRpc: async (method) => {
					if (method === 'pm_isSponsorable') return { sponsorable: true, sponsorAddress: '0xabc' };
					if (method === 'eth_sendRawTransaction') return '0x' + 'a'.repeat(64);
					throw new Error(`unexpected method ${method}`);
				},
			},
		);
		expect(result.mode).toBe('sponsored');
		expect(result.hash).toBe('0x' + 'a'.repeat(64));
	});

	it('sendMove falls back to self-pay when MegaFuel declines', async () => {
		const walletClient = { sendTransaction: vi.fn().mockResolvedValue('0x' + 'b'.repeat(64)) };
		const result = await sendMove(
			{ account, worldId: 1, pos: { x: 1, y: 1, z: 1 }, facing: 0, network: 'bscTestnet' },
			{
				address: WORLD_MOVES_ADDR,
				publicClient: mockPublicClient(),
				walletClient,
				megafuelRpc: async () => ({ sponsorable: false, reason: 'no policy for this address' }),
			},
		);
		expect(result.mode).toBe('self-pay');
		expect(result.reason).toMatch(/no policy/);
		expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
	});

	it('sendMove self-pays when MegaFuel is unreachable (RPC throws)', async () => {
		const walletClient = { sendTransaction: vi.fn().mockResolvedValue('0x' + 'c'.repeat(64)) };
		const result = await sendMove(
			{ account, worldId: 1, pos: { x: 1, y: 1, z: 1 }, facing: 0, network: 'bscTestnet' },
			{
				address: WORLD_MOVES_ADDR,
				publicClient: mockPublicClient(),
				walletClient,
				megafuelRpc: async () => {
					throw new Error('network unreachable');
				},
			},
		);
		expect(result.mode).toBe('self-pay');
		expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
	});

	it('sendJoin and sendLeave route through the same sponsored path', async () => {
		const megafuelRpc = async (method) => {
			if (method === 'pm_isSponsorable') return { sponsorable: true };
			if (method === 'eth_sendRawTransaction') return '0x' + 'd'.repeat(64);
			throw new Error(`unexpected ${method}`);
		};
		const join = await sendJoin({ account, worldId: 1 }, { address: WORLD_MOVES_ADDR, publicClient: mockPublicClient(), megafuelRpc });
		expect(join.mode).toBe('sponsored');
		const leave = await sendLeave({ account, worldId: 1 }, { address: WORLD_MOVES_ADDR, publicClient: mockPublicClient(), megafuelRpc });
		expect(leave.mode).toBe('sponsored');
	});
});

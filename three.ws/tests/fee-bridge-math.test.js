import { describe, it, expect } from 'vitest';

import {
	allocateProRata,
	computeBatchCredits,
	lamportDelta,
	netOfGas,
	parseXHandle,
	payoutDecision,
	splitRecipientBuyback,
	tokenDelta,
} from '../api/_lib/fee-bridge/math.js';

describe('parseXHandle', () => {
	it('accepts bare handles, @handles and profile URLs', () => {
		expect(parseXHandle('three_ws')).toBe('three_ws');
		expect(parseXHandle('  @Three_WS ')).toBe('Three_WS');
		expect(parseXHandle('https://x.com/nirholas')).toBe('nirholas');
		expect(parseXHandle('twitter.com/nirholas/status/123')).toBe('nirholas');
		expect(parseXHandle('https://mobile.twitter.com/nirholas?s=20')).toBe('nirholas');
	});

	it('rejects anything that is not an X handle', () => {
		expect(parseXHandle('')).toBeNull();
		expect(parseXHandle(null)).toBeNull();
		expect(parseXHandle('has space')).toBeNull();
		expect(parseXHandle('sixteen_chars_xx')).toBeNull();
		expect(parseXHandle('dash-name')).toBeNull();
	});
});

describe('splitRecipientBuyback', () => {
	it('splits 80/20 exactly on round amounts', () => {
		expect(splitRecipientBuyback(10_000_000n, 8000)).toEqual({ recipient: 8_000_000n, buyback: 2_000_000n });
	});

	it('floors the recipient so rounding dust goes to the buyback, never over-crediting', () => {
		const { recipient, buyback } = splitRecipientBuyback(7n, 8000);
		expect(recipient).toBe(5n);
		expect(buyback).toBe(2n);
		expect(recipient + buyback).toBe(7n);
	});

	it('clamps bps and ignores negative totals', () => {
		expect(splitRecipientBuyback(100n, 12_000)).toEqual({ recipient: 100n, buyback: 0n });
		expect(splitRecipientBuyback(-5n, 8000)).toEqual({ recipient: 0n, buyback: 0n });
	});
});

describe('netOfGas', () => {
	it('charges gas back and never goes negative', () => {
		expect(netOfGas(1_000_000n, 5_000n)).toBe(995_000n);
		expect(netOfGas(4_000n, 5_000n)).toBe(0n);
		expect(netOfGas(4_000n, -1n)).toBe(4_000n);
	});
});

describe('allocateProRata', () => {
	it('sums to exactly the total with largest-remainder rounding', () => {
		const out = allocateProRata(100n, [
			{ key: 'a', weight: 1n },
			{ key: 'b', weight: 1n },
			{ key: 'c', weight: 1n },
		]);
		expect([...out.values()].reduce((x, y) => x + y, 0n)).toBe(100n);
		expect(out.get('a')).toBe(34n);
		expect(out.get('b')).toBe(33n);
		expect(out.get('c')).toBe(33n);
	});

	it('gives zero-weight keys nothing and handles an empty pool', () => {
		const out = allocateProRata(50n, [
			{ key: 'a', weight: 3n },
			{ key: 'z', weight: 0n },
		]);
		expect(out.get('a')).toBe(50n);
		expect(out.get('z')).toBe(0n);
		expect(allocateProRata(0n, [{ key: 'a', weight: 1n }]).get('a')).toBe(0n);
	});
});

describe('computeBatchCredits', () => {
	it('shares swapped USDC by net SOL, adds USDC inflows at face value, and splits each coin', () => {
		const { credits, recipientTotal, buybackTotal, usdcTotal } = computeBatchCredits({
			coins: [
				{ mint: 'MintA', handle_lc: 'alice', sol_net: 3_000_000_000n, usdc_in: 0n },
				{ mint: 'MintB', handle_lc: 'bob', sol_net: 1_000_000_000n, usdc_in: 0n },
				{ mint: 'MintC', handle_lc: 'carol', sol_net: 0n, usdc_in: 10_000_000n },
			],
			usdcFromSol: 600_000_000n,
			recipientBps: 8000,
		});
		const by = Object.fromEntries(credits.map((c) => [c.mint, c.usdc_atomics]));
		expect(by.MintA).toBe(360_000_000n);
		expect(by.MintB).toBe(120_000_000n);
		expect(by.MintC).toBe(8_000_000n);
		expect(usdcTotal).toBe(610_000_000n);
		expect(recipientTotal + buybackTotal).toBe(610_000_000n);
		expect(buybackTotal).toBe(122_000_000n);
	});

	it('never credits more than the batch produced', () => {
		const { recipientTotal, buybackTotal } = computeBatchCredits({
			coins: [
				{ mint: 'A', handle_lc: 'a', sol_net: 1n, usdc_in: 0n },
				{ mint: 'B', handle_lc: 'b', sol_net: 1n, usdc_in: 0n },
				{ mint: 'C', handle_lc: 'c', sol_net: 1n, usdc_in: 0n },
			],
			usdcFromSol: 1_000_001n,
			recipientBps: 8000,
		});
		expect(recipientTotal + buybackTotal).toBe(1_000_001n);
		expect(recipientTotal).toBeLessThanOrEqual(800_001n);
	});
});

describe('payoutDecision', () => {
	const floors = { autoFloor: 5_000_000n, withdrawFloor: 1_000_000n };

	it('auto-pays only past the auto floor', () => {
		expect(payoutDecision({ balance: 4_999_999n, trigger: 'auto', ...floors })).toMatchObject({ pay: false, reason: 'below_floor' });
		expect(payoutDecision({ balance: 5_000_000n, trigger: 'auto', ...floors })).toEqual({ pay: true, amount: 5_000_000n });
	});

	it('lets a manual withdrawal go from the lower floor', () => {
		expect(payoutDecision({ balance: 1_500_000n, trigger: 'withdraw', ...floors })).toEqual({ pay: true, amount: 1_500_000n });
		expect(payoutDecision({ balance: 0n, trigger: 'withdraw', ...floors })).toMatchObject({ pay: false, reason: 'no_balance' });
	});
});

describe('transaction deltas', () => {
	it('reads an owner token delta, treating a new account as starting from zero', () => {
		const meta = {
			preTokenBalances: [{ owner: 'bridge', mint: 'usdc', uiTokenAmount: { amount: '100' } }],
			postTokenBalances: [
				{ owner: 'bridge', mint: 'usdc', uiTokenAmount: { amount: '350' } },
				{ owner: 'bridge', mint: 'three', uiTokenAmount: { amount: '9' } },
				{ owner: 'other', mint: 'usdc', uiTokenAmount: { amount: '999' } },
			],
		};
		expect(tokenDelta(meta, 'bridge', 'usdc')).toBe(250n);
		expect(tokenDelta(meta, 'bridge', 'three')).toBe(9n);
		expect(tokenDelta(null, 'bridge', 'usdc')).toBe(0n);
	});

	it('adds the fee back for the fee payer so a crank inflow is not understated', () => {
		const meta = { preBalances: [1_000_000, 5], postBalances: [1_495_000, 5], fee: 5_000 };
		expect(lamportDelta(meta, 0, true)).toBe(500_000n);
		expect(lamportDelta(meta, 0, false)).toBe(495_000n);
		expect(lamportDelta(meta, -1, true)).toBe(0n);
	});
});

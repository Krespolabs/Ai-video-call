// @vitest-environment jsdom
// public/x402.js reads location.origin at import time, so this suite runs under
// a DOM environment.
import { describe, it, expect } from 'vitest';

import { computeGiving } from '../public/x402.js';

// A valid base58 Solana address (the wrapped-SOL mint) — used purely as a
// well-formed destination placeholder for the cause wallet.
const SOL = 'So11111111111111111111111111111111111111112';
const acc = (amount, network = 'solana') => ({ amount: String(amount), network, extra: { decimals: 6, name: 'USDC' } });

describe('computeGiving — charity + round-up donation math', () => {
	it('returns null when no giving config is provided', () => {
		expect(computeGiving(null, acc(1_000_000))).toBeNull();
		expect(computeGiving(undefined, acc(1_000_000))).toBeNull();
	});

	it('returns null on a non-Solana checkout (donation must share the mint/chain)', () => {
		const giving = { charity_enabled: true, charity_bps: 1000, charity_address: SOL, charity_chain: 'solana' };
		expect(computeGiving(giving, acc(1_000_000, 'eip155:8453'))).toBeNull();
	});

	it('returns null when the cause wallet is on a different chain', () => {
		const giving = { charity_enabled: true, charity_bps: 1000, charity_address: '0xabc', charity_chain: 'base' };
		expect(computeGiving(giving, acc(1_000_000))).toBeNull();
	});

	it('returns null when the cause address is not valid base58', () => {
		const giving = { charity_enabled: true, charity_bps: 1000, charity_address: 'not-an-address!!', charity_chain: 'solana' };
		expect(computeGiving(giving, acc(1_000_000))).toBeNull();
	});

	it('computes a charity split as basis points of the payment (floored)', () => {
		// 7.5% of 1.000000 USDC = 0.075000 USDC
		const giving = { charity_enabled: true, charity_bps: 750, charity_address: SOL, charity_chain: 'solana' };
		const g = computeGiving(giving, acc(1_000_000));
		expect(g.charity).toBe('75000');
		expect(g.roundup).toBe('0');
		expect(g.amount).toBe('75000');
		expect(g.total).toBe('1075000');
		expect(g.to).toBe(SOL);
	});

	it('floors fractional charity atomics rather than rounding up', () => {
		// 10% of 1 atomic = 0.1 atomic → floors to 0 → nothing to donate → null
		const giving = { charity_enabled: true, charity_bps: 1000, charity_address: SOL, charity_chain: 'solana' };
		expect(computeGiving(giving, acc(1))).toBeNull();
	});

	it('computes the round-up remainder to the nearest unit', () => {
		// pay 0.001 USDC (1000 atomics), round up to nearest 0.01 USDC (10000 atomics)
		// remainder = 10000 - 1000 = 9000
		const giving = { roundup_enabled: true, roundup_to_atomics: '10000', charity_address: SOL, charity_chain: 'solana' };
		const g = computeGiving(giving, acc(1000));
		expect(g.roundup).toBe('9000');
		expect(g.charity).toBe('0');
		expect(g.amount).toBe('9000');
		expect(g.total).toBe('10000');
	});

	it('adds nothing when the payment is already on a round boundary', () => {
		const giving = { roundup_enabled: true, roundup_to_atomics: '10000', charity_address: SOL, charity_chain: 'solana' };
		expect(computeGiving(giving, acc(20000))).toBeNull();
	});

	it('combines charity split and round-up into one donation', () => {
		// pay 0.001 (1000). charity 10% = 100. round up to 0.01 → remainder 9000.
		const giving = {
			charity_enabled: true,
			charity_bps: 1000,
			roundup_enabled: true,
			roundup_to_atomics: '10000',
			charity_address: SOL,
			charity_chain: 'solana',
		};
		const g = computeGiving(giving, acc(1000));
		expect(g.charity).toBe('100');
		expect(g.roundup).toBe('9000');
		expect(g.amount).toBe('9100');
		expect(g.total).toBe('10100');
	});

	it('ignores disabled primitives', () => {
		const giving = {
			charity_enabled: false,
			charity_bps: 1000,
			roundup_enabled: false,
			roundup_to_atomics: '10000',
			charity_address: SOL,
			charity_chain: 'solana',
		};
		expect(computeGiving(giving, acc(1000))).toBeNull();
	});
});

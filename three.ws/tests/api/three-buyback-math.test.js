// Unit tests for the programmatic $THREE buyback sizing + policy math.
//
// Pure logic — no DB, no RPC, no web3. Verifies that a run spends up to the
// per-run cap bounded by the live wallet balance, skips correctly below the
// minimum, and that the public ratio / unit conversions are exact.

import { describe, it, expect } from 'vitest';

import {
	USDC_ATOMICS,
	computeSpend,
	deployedPct,
	committedUsd,
	commitmentProgressPct,
	envBps,
	envSlippageBps,
	envUsd,
	usdToUsdcAtomics,
	usdcAtomicsToUsd,
	atomicsToTokens,
} from '../../api/_lib/token/buyback-math.js';

const usdc = (n) => usdToUsdcAtomics(n); // whole USD → atomics

describe('buyback computeSpend', () => {
	const caps = { maxUsd: 250, minUsd: 10 };

	it('skips an empty wallet with reason "empty"', () => {
		expect(computeSpend(0n, caps)).toEqual({ spendAtomics: 0n, reason: 'empty' });
	});

	it('skips a wallet below the minimum with reason "below_threshold"', () => {
		// $9.99 < $10 minimum
		expect(computeSpend(usdc(9.99), caps)).toEqual({ spendAtomics: 0n, reason: 'below_threshold' });
	});

	it('spends the full balance when between min and cap', () => {
		const r = computeSpend(usdc(120), caps);
		expect(r.reason).toBe('ok');
		expect(r.spendAtomics).toBe(usdc(120));
	});

	it('caps the spend at the per-run maximum, leaving the rest in the wallet', () => {
		const r = computeSpend(usdc(1000), caps);
		expect(r.reason).toBe('ok');
		expect(r.spendAtomics).toBe(usdc(250)); // capped, not 1000
	});

	it('spends exactly the minimum at the boundary', () => {
		const r = computeSpend(usdc(10), caps);
		expect(r.reason).toBe('ok');
		expect(r.spendAtomics).toBe(usdc(10));
	});

	it('accepts string/number atomics inputs (DB bigints arrive as strings)', () => {
		expect(computeSpend('50000000', caps)).toEqual({ spendAtomics: 50_000_000n, reason: 'ok' }); // $50
	});
});

describe('buyback deployedPct', () => {
	it('is 0 when no revenue has been earned', () => {
		expect(deployedPct(0, 0)).toBe(0);
		expect(deployedPct(5, 0)).toBe(0);
	});

	it('computes the deployed share of revenue', () => {
		expect(deployedPct(25, 100)).toBe(25);
	});

	it('clamps to 100 even if more was deployed than the measured revenue', () => {
		// deployed can exceed the fee ledger when the wallet is topped up directly.
		expect(deployedPct(150, 100)).toBe(100);
	});
});

describe('buyback commitment math', () => {
	it('committedUsd applies the commitment bps to revenue', () => {
		expect(committedUsd(1000, 5000)).toBe(500); // 50% of $1000
		expect(committedUsd(1000, 8000)).toBe(800); // 80%
		expect(committedUsd(250, 10_000)).toBe(250); // full revenue
	});

	it('committedUsd is 0 for non-positive revenue or commitment', () => {
		expect(committedUsd(0, 5000)).toBe(0);
		expect(committedUsd(-10, 5000)).toBe(0);
		expect(committedUsd(1000, 0)).toBe(0);
	});

	it('commitmentProgressPct measures deployed against the committed target', () => {
		expect(commitmentProgressPct(250, 500)).toBe(50); // half the promise kept
		expect(commitmentProgressPct(0, 500)).toBe(0); // nothing deployed yet
		expect(commitmentProgressPct(500, 500)).toBe(100); // promise fully kept
	});

	it('commitmentProgressPct clamps to 100 and is 0 when nothing is committed', () => {
		expect(commitmentProgressPct(600, 500)).toBe(100); // over-deployed → capped
		expect(commitmentProgressPct(50, 0)).toBe(0); // no commitment target yet
	});

	it('envBps parses [0,10000], else falls back', () => {
		expect(envBps(undefined, 5000)).toBe(5000);
		expect(envBps('', 5000)).toBe(5000);
		expect(envBps('8000', 5000)).toBe(8000);
		expect(envBps('0', 5000)).toBe(0); // 0% is a valid (if odd) commitment
		expect(envBps('10000', 5000)).toBe(10_000);
		expect(envBps('10001', 5000)).toBe(5000); // over ceiling → fallback
		expect(envBps('-1', 5000)).toBe(5000); // negative → fallback
		expect(envBps('abc', 5000)).toBe(5000);
		expect(envBps('5000.6', 5000)).toBe(5001); // rounds
	});
});

describe('buyback unit conversions', () => {
	it('round-trips USD ↔ USDC atomics', () => {
		expect(usdToUsdcAtomics(1)).toBe(USDC_ATOMICS);
		expect(usdcAtomicsToUsd(USDC_ATOMICS)).toBe(1);
		expect(usdcAtomicsToUsd(usdToUsdcAtomics(42.5))).toBe(42.5);
	});

	it('converts $THREE atomics to whole tokens at 6 decimals', () => {
		expect(atomicsToTokens(1_000_000n, 6)).toBe(1);
		expect(atomicsToTokens(2_500_000n, 6)).toBe(2.5);
	});
});

describe('buyback env parsing', () => {
	it('falls back when unset, empty, or non-positive', () => {
		expect(envUsd(undefined, 250)).toBe(250);
		expect(envUsd('', 250)).toBe(250);
		expect(envUsd('0', 250)).toBe(250);
		expect(envUsd('-5', 250)).toBe(250);
		expect(envUsd('abc', 250)).toBe(250);
	});

	it('parses a valid positive USD override', () => {
		expect(envUsd('500', 250)).toBe(500);
		expect(envUsd('12.5', 10)).toBe(12.5);
	});

	it('clamps slippage to (0, 5000] bps and rounds', () => {
		expect(envSlippageBps(undefined)).toBe(300);
		expect(envSlippageBps('0')).toBe(300);
		expect(envSlippageBps('6000')).toBe(300); // over ceiling → fallback
		expect(envSlippageBps('150')).toBe(150);
		expect(envSlippageBps('150.7')).toBe(151);
	});
});

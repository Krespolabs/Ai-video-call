// Unit tests for the Living Stages tip split + settlement validation
// (api/_lib/stage-split.js) — pure, integer-only money math + the "no settlement
// proof, no row" discipline. Runs without a DB or a socket.

import { describe, it, expect } from 'vitest';
import {
	THREE_MINT,
	splitTip,
	normalizeSplitBps,
	parseAtomicAmount,
	isValidTipSignature,
	isAllowedTipMint,
	validateTipPayload,
	tipExplorerUrl,
	DEFAULT_TIP_SPLIT_BPS,
} from '../api/_lib/stage-split.js';

const SOL_SIG = '5'.padEnd(64, 'A'); // base58-shaped, 64 chars
const EVM_TX = '0x' + 'a'.repeat(64);
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('splitTip — host/venue accounting', () => {
	it('host + venue always reconcile to the exact amount (fuzz)', () => {
		const bpsVals = [0, 1, 250, 1000, 3333, 5000, 9999, 10000];
		for (let i = 0; i < 500; i++) {
			const amount = 1 + Math.floor(Math.abs(Math.sin(i * 12.9898) * 1e6) * 1000);
			for (const bps of bpsVals) {
				const { hostCredit, venueCut } = splitTip(amount, bps);
				expect(hostCredit + venueCut).toBe(amount);
				expect(Number.isInteger(hostCredit)).toBe(true);
				expect(Number.isInteger(venueCut)).toBe(true);
				expect(venueCut).toBeGreaterThanOrEqual(0);
				expect(hostCredit).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it('floors the venue cut and hands the remainder to the host', () => {
		// 1001 atomic at 50% → venue floor(500.5)=500, host 501.
		const { hostCredit, venueCut } = splitTip(1001, 5000);
		expect(venueCut).toBe(500);
		expect(hostCredit).toBe(501);
	});

	it('0 bps → host keeps everything; 10000 bps → venue takes all', () => {
		expect(splitTip(1000, 0)).toMatchObject({ hostCredit: 1000, venueCut: 0 });
		expect(splitTip(1000, 10000)).toMatchObject({ hostCredit: 0, venueCut: 1000 });
	});

	it('applies the platform default split when bps is omitted/invalid', () => {
		expect(splitTip(10000).splitBps).toBe(DEFAULT_TIP_SPLIT_BPS);
		expect(splitTip(10000, -5).splitBps).toBe(DEFAULT_TIP_SPLIT_BPS);
		expect(splitTip(10000, 99999).splitBps).toBe(DEFAULT_TIP_SPLIT_BPS);
	});

	it('rejects a non-positive-integer amount', () => {
		expect(() => splitTip(0)).toThrow();
		expect(() => splitTip(-5)).toThrow();
		expect(() => splitTip(1.5)).toThrow();
	});
});

describe('normalizeSplitBps', () => {
	it('clamps out-of-range / non-finite to the default, keeps valid', () => {
		expect(normalizeSplitBps(2500)).toBe(2500);
		expect(normalizeSplitBps(0)).toBe(0);
		expect(normalizeSplitBps(10000)).toBe(10000);
		expect(normalizeSplitBps(-1)).toBe(DEFAULT_TIP_SPLIT_BPS);
		expect(normalizeSplitBps(10001)).toBe(DEFAULT_TIP_SPLIT_BPS);
		expect(normalizeSplitBps('abc')).toBe(DEFAULT_TIP_SPLIT_BPS);
	});
});

describe('parseAtomicAmount', () => {
	it('accepts positive integers, rejects everything else', () => {
		expect(parseAtomicAmount(1)).toBe(1);
		expect(parseAtomicAmount('1000000')).toBe(1000000);
		expect(parseAtomicAmount(0)).toBeNull();
		expect(parseAtomicAmount(-1)).toBeNull();
		expect(parseAtomicAmount(1.5)).toBeNull();
		expect(parseAtomicAmount(NaN)).toBeNull();
		expect(parseAtomicAmount(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
	});
});

describe('settlement signature + mint validation', () => {
	it('accepts EVM tx hashes and base58 Solana sigs', () => {
		expect(isValidTipSignature(EVM_TX)).toBe(true);
		expect(isValidTipSignature(SOL_SIG)).toBe(true);
		expect(isValidTipSignature('not-a-sig')).toBe(false);
		expect(isValidTipSignature('0xshort')).toBe(false);
		expect(isValidTipSignature(null)).toBe(false);
	});

	it('only $THREE and USDC are allowed mints', () => {
		expect(isAllowedTipMint(THREE_MINT)).toBe(true);
		expect(isAllowedTipMint(USDC_SOL)).toBe(true);
		// EVM USDC compares case-insensitively.
		expect(isAllowedTipMint('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'.toUpperCase())).toBe(true);
		expect(isAllowedTipMint('SomeOtherMint1111111111111111111111111111')).toBe(false);
		expect(isAllowedTipMint('')).toBe(false);
	});

	it('$THREE is the canonical coin address', () => {
		expect(THREE_MINT).toBe('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
	});
});

describe('validateTipPayload', () => {
	it('passes a well-formed $THREE tip and normalizes the network', () => {
		const out = validateTipPayload({ signature: SOL_SIG, currencyMint: THREE_MINT, amount: 5_000_000, network: 'solana' });
		expect(out).toMatchObject({ ok: true, amount: 5_000_000, mint: THREE_MINT, network: 'solana' });
	});

	it('rejects a missing/garbage signature', () => {
		expect(validateTipPayload({ signature: 'x', currencyMint: THREE_MINT, amount: 1 }).ok).toBe(false);
	});

	it('rejects a disallowed mint', () => {
		const out = validateTipPayload({ signature: SOL_SIG, currencyMint: 'Bad', amount: 1 });
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/THREE or USDC/);
	});

	it('rejects a non-integer amount', () => {
		expect(validateTipPayload({ signature: SOL_SIG, currencyMint: THREE_MINT, amount: 1.5 }).ok).toBe(false);
		expect(validateTipPayload({ signature: SOL_SIG, currencyMint: THREE_MINT, amount: 0 }).ok).toBe(false);
	});
});

describe('tipExplorerUrl', () => {
	it('routes EVM tx to Basescan and Solana sig to Solscan', () => {
		expect(tipExplorerUrl(EVM_TX)).toContain('basescan.org');
		expect(tipExplorerUrl(SOL_SIG)).toContain('solscan.io');
		expect(tipExplorerUrl(null)).toBeNull();
	});
});

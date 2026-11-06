// Unit tests for the payment receipt formatter. This is money-facing UI copy —
// the amount, timing, and (critically) the explorer link are rendered straight
// into the DOM, so the formatting and the URL allowlisting must stay correct.

import { describe, it, expect } from 'vitest';
import {
	formatUsdcAmount,
	formatElapsed,
	buildReceiptHTML,
	buildReceiptText,
} from '../src/shared/payment-receipt.js';

describe('formatUsdcAmount', () => {
	it('renders atomic micro-USDC as a dollar amount', () => {
		expect(formatUsdcAmount(10_000, true)).toBe('$0.01');
		expect(formatUsdcAmount(1_000_000, true)).toBe('$1.00');
		expect(formatUsdcAmount(2_500_000, true)).toBe('$2.50');
	});

	it('renders already-decimal values without scaling', () => {
		expect(formatUsdcAmount(0.01, false)).toBe('$0.01');
		expect(formatUsdcAmount(2.5, false)).toBe('$2.50');
	});

	it('uses extra precision for sub-cent amounts', () => {
		expect(formatUsdcAmount(0.001, false)).toBe('$0.0010');
	});

	it('rounds whole-dollar amounts >= 100', () => {
		expect(formatUsdcAmount(150, false)).toBe('$150');
		// Grouping separator is locale-dependent, so match loosely.
		expect(formatUsdcAmount(1234.56, false)).toMatch(/^\$1[,\s]?235$/);
	});

	it('treats values >= 1000 as atomic when isAtomic is not given (documented heuristic)', () => {
		expect(formatUsdcAmount(10_000)).toBe('$0.01');
	});

	it('never throws on garbage input', () => {
		expect(formatUsdcAmount(undefined)).toBe('$0.0000');
		expect(formatUsdcAmount(NaN)).toBe('$0.0000');
		expect(formatUsdcAmount('not a number')).toBe('$0.0000');
	});
});

describe('formatElapsed', () => {
	it('uses "just now" under two seconds', () => {
		expect(formatElapsed(0)).toBe('just now');
		expect(formatElapsed(1400)).toBe('just now');
	});

	it('renders seconds, minutes, and hours', () => {
		expect(formatElapsed(2000)).toBe('2s');
		expect(formatElapsed(45_000)).toBe('45s');
		expect(formatElapsed(90_000)).toBe('2m'); // 90s rounds to 2m
		expect(formatElapsed(3_600_000)).toBe('1h');
	});

	it('rolls 60 minutes up to 1h rather than showing "60m"', () => {
		expect(formatElapsed(59 * 60 * 1000 + 40 * 1000)).toBe('1h');
	});

	it('never throws on missing input', () => {
		expect(formatElapsed()).toBe('just now');
	});
});

describe('buildReceiptHTML', () => {
	it('builds a paid line with amount, recipient, and timing', () => {
		const html = buildReceiptHTML({
			usdcAtomic: 10_000,
			recipientLabel: 'creator',
			elapsedMs: 2000,
		});
		expect(html).toContain('✓ Paid $0.01');
		expect(html).toContain('to creator');
		expect(html).toContain('· 2s');
	});

	it('links to a whitelisted explorer origin', () => {
		const html = buildReceiptHTML({
			usdcAtomic: 10_000,
			explorerUrl: 'https://solscan.io/tx/abc123',
		});
		expect(html).toContain('href="https://solscan.io/tx/abc123"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('details ↗');
	});

	it('refuses a non-whitelisted explorer origin and falls back to a truncated signature', () => {
		const html = buildReceiptHTML({
			usdcAtomic: 10_000,
			explorerUrl: 'https://evil.example.com/tx/abc',
			signature: 'abcdef1234567890ZZZZ',
		});
		expect(html).not.toContain('evil.example.com');
		expect(html).not.toContain('<a');
		expect(html).toContain('abcdef…ZZZZ');
	});

	it('escapes a hostile recipient label so it cannot inject markup', () => {
		const html = buildReceiptHTML({
			usdcAtomic: 10_000,
			recipientLabel: '<img src=x onerror=alert(1)>',
		});
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img');
	});

	it('degrades gracefully when no amount is provided', () => {
		expect(buildReceiptHTML({})).toContain('✓ Paid payment');
	});
});

describe('buildReceiptText', () => {
	it('produces a plain-text receipt for toasts', () => {
		expect(
			buildReceiptText({ usdcAtomic: 10_000, recipientLabel: 'creator', elapsedMs: 2000 }),
		).toBe('✓ Paid $0.01 to creator · 2s');
	});
});

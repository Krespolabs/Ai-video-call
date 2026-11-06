// The wallet program's single money + address formatter (src/shared/wallet-format.js).
// One helper per concern: the chip re-exports formatWalletUsd, and the net-worth
// presence layer's fmtUsd delegates to it, so the SAME value reads identically
// across the chip and the inline net-worth figure.

import { describe, it, expect } from 'vitest';
import { formatWalletUsd, formatWalletUsdSafe, shortAddress } from '../src/shared/wallet-format.js';
import { formatWalletUsd as chipUsd } from '../src/shared/agent-wallet-chip.js';
import { fmtUsd } from '../src/shared/agent-networth.js';

describe('formatWalletUsd · compact USD tiers', () => {
	it('renders each magnitude band', () => {
		expect(formatWalletUsd(0)).toBe('$0');
		expect(formatWalletUsd(0.004)).toBe('<$0.01');
		expect(formatWalletUsd(9.4)).toBe('$9.40');
		expect(formatWalletUsd(950)).toBe('$950');
		expect(formatWalletUsd(1200)).toBe('$1.2K');
		expect(formatWalletUsd(34_000)).toBe('$34K');
		expect(formatWalletUsd(3_400_000)).toBe('$3.4M');
		expect(formatWalletUsd(1_100_000_000)).toBe('$1.1B');
	});

	it('returns null for non-finite so callers can omit the figure', () => {
		expect(formatWalletUsd(null)).toBeNull();
		expect(formatWalletUsd(undefined)).toBeNull();
		expect(formatWalletUsd(NaN)).toBeNull();
	});

	it('formatWalletUsdSafe coerces missing values to $0', () => {
		expect(formatWalletUsdSafe(null)).toBe('$0');
		expect(formatWalletUsdSafe(NaN)).toBe('$0');
		expect(formatWalletUsdSafe(1200)).toBe('$1.2K');
	});
});

describe('one formatter, every surface', () => {
	it('the chip re-export is the same function', () => {
		expect(chipUsd).toBe(formatWalletUsd);
	});

	it('net-worth fmtUsd agrees with the chip on compact output', () => {
		for (const v of [0, 9.4, 950, 1200, 34_000, 3_400_000]) {
			expect(fmtUsd(v)).toBe(formatWalletUsdSafe(v));
		}
		// The casing drift is gone: compact thousands read "$1.2K", never "$1k".
		expect(fmtUsd(1200)).toBe('$1.2K');
	});
});

describe('shortAddress · address shortening', () => {
	it('shortens long addresses head…tail', () => {
		expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678', 6, 4)).toBe('0x1234…5678');
		expect(shortAddress('So11111111111111111111111111111111111111112')).toBe('So11…1112');
	});

	it('leaves already-short values intact', () => {
		expect(shortAddress('abc')).toBe('abc');
		expect(shortAddress('')).toBe('');
		expect(shortAddress(null)).toBe('');
	});
});

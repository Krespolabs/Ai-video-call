import { describe, it, expect } from 'vitest';
import {
	CHAIN_IDS,
	ERC20_ABI,
	NATIVE_TOKENS,
	SOLANA_MINTS,
	TOKEN_ADDRESSES,
	getChainId,
	getNativeToken,
	isNativeToken,
	resolveSolanaMint,
	resolveTokenAddress,
	isEvmAddress,
	isSolanaAddress,
	validateAddress,
	validateAmount,
	validateSolanaAddress,
	fmtAmount,
	fmtPct,
	fmtUsd,
} from '../src/index.js';

describe('chain-id resolution', () => {
	it('resolves known names case-insensitively', () => {
		expect(getChainId('arbitrum')).toBe(42_161);
		expect(getChainId('Ethereum')).toBe(1);
		expect(getChainId('BSC')).toBe(56);
		expect(getChainId('base')).toBe(8453);
	});
	it('defaults unknown chains to Arbitrum', () => {
		expect(getChainId('nonexistent-chain')).toBe(42_161);
	});
	it('exposes the raw CHAIN_IDS map', () => {
		expect(CHAIN_IDS.polygon).toBe(137);
		expect(CHAIN_IDS.sonic).toBe(146);
	});
});

describe('native-token detection', () => {
	it('returns the native symbol per chain, defaulting to ETH', () => {
		expect(getNativeToken(1)).toBe('ETH');
		expect(getNativeToken(56)).toBe('BNB');
		expect(getNativeToken(137)).toBe('MATIC');
		expect(getNativeToken(99999)).toBe('ETH');
		expect(NATIVE_TOKENS[43_114]).toBe('AVAX');
	});
	it('detects native token aliases in mixed case', () => {
		expect(isNativeToken('eth')).toBe(true);
		expect(isNativeToken('BNB')).toBe(true);
		expect(isNativeToken('xDAI')).toBe(true);
		expect(isNativeToken('USDC')).toBe(false);
	});
});

describe('token resolution', () => {
	it('resolves symbols to addresses per chain', () => {
		expect(resolveTokenAddress('USDC', 1)).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
		expect(resolveTokenAddress('usdc', 8453)).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
	});
	it('resolves the Sperax integration tokens on Arbitrum (42161)', () => {
		expect(resolveTokenAddress('SPA', 42_161)).toBe('0x5575552988A3A80504bBaeB1311674fCFd40aD4B');
		expect(resolveTokenAddress('USDs', 42_161)).toBe('0xD74f5255D557944cf7Dd0E45FF521520002D5748');
		expect(TOKEN_ADDRESSES[42_161].SPA).toBeDefined();
	});
	it('resolves mixed-case map keys regardless of input casing', () => {
		// USDs and USDC.e are stored mixed-case for display; lookup must not
		// assume every key is pre-uppercased.
		expect(resolveTokenAddress('usds', 42_161)).toBe('0xD74f5255D557944cf7Dd0E45FF521520002D5748');
		expect(resolveTokenAddress('USDS', 42_161)).toBe('0xD74f5255D557944cf7Dd0E45FF521520002D5748');
		expect(resolveTokenAddress('USDC.e', 42_161)).toBe('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8');
		expect(resolveTokenAddress('usdc.e', 42_161)).toBe('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8');
	});
	it('returns an address input as-is', () => {
		const addr = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8';
		expect(resolveTokenAddress(addr, 42_161)).toBe(addr);
	});
	it('returns undefined for unknown symbols', () => {
		expect(resolveTokenAddress('NOPE', 1)).toBeUndefined();
		expect(resolveTokenAddress('USDC', 99999)).toBeUndefined();
	});
});

describe('Solana mints', () => {
	it('resolves symbols to mints case-insensitively', () => {
		expect(resolveSolanaMint('SOL')).toBe(SOLANA_MINTS.SOL);
		expect(resolveSolanaMint('usdc')).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
		expect(resolveSolanaMint('THREE')).toBe('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
	});
	it('returns a mint-looking input as-is', () => {
		const mint = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
		expect(resolveSolanaMint(mint)).toBe(mint);
	});
	it('returns undefined for unknown symbols', () => {
		expect(resolveSolanaMint('NOPE')).toBeUndefined();
		expect(resolveSolanaMint('')).toBeUndefined();
	});
});

describe('EVM address validation', () => {
	it('accepts checksummed and lowercase addresses', () => {
		expect(validateAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBeNull();
		expect(validateAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBeNull();
		expect(isEvmAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true);
	});
	it('rejects malformed addresses with a message', () => {
		expect(validateAddress('0x123')).toMatch(/Invalid wallet address/);
		expect(validateAddress('not-an-address')).toMatch(/Invalid wallet address/);
		expect(validateAddress('')).toMatch(/Invalid wallet address/);
		expect(isEvmAddress('0x123')).toBe(false);
	});
});

describe('amount validation', () => {
	it('accepts positive numbers and "max"', () => {
		expect(validateAmount('1.5')).toBeNull();
		expect(validateAmount('max')).toBeNull();
		expect(validateAmount('MAX')).toBeNull();
	});
	it('rejects empty, zero, negative, and non-numeric amounts', () => {
		expect(validateAmount('')).toMatch(/required/);
		expect(validateAmount('0')).toMatch(/Invalid amount/);
		expect(validateAmount('-5')).toMatch(/Invalid amount/);
		expect(validateAmount('abc')).toMatch(/Invalid amount/);
	});
});

describe('Solana address validation', () => {
	it('accepts valid 32-byte base58 mints', () => {
		expect(validateSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBeNull();
		expect(validateSolanaAddress('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump')).toBeNull();
		expect(isSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true);
	});
	it('rejects too-short strings', () => {
		expect(validateSolanaAddress('abc')).toMatch(/32–44|32-44/);
		expect(isSolanaAddress('abc')).toBe(false);
	});
	it('rejects non-base58 characters', () => {
		// 0 and O and l and I are not in the base58 alphabet; length in range.
		expect(validateSolanaAddress('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl')).toMatch(/base58|32 bytes/);
	});
	it('rejects EVM addresses (wrong shape for Solana)', () => {
		expect(isSolanaAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(false);
	});
});

describe('formatters (exact output)', () => {
	it('fmtUsd', () => {
		expect(fmtUsd(1234.5)).toBe('$1,234.50');
		expect(fmtUsd(0)).toBe('$0.00');
		expect(fmtUsd(1000000)).toBe('$1,000,000.00');
	});
	it('fmtPct', () => {
		expect(fmtPct(5.42)).toBe('5.42%');
		expect(fmtPct(0)).toBe('0.00%');
		expect(fmtPct(100)).toBe('100.00%');
	});
	it('fmtAmount scales precision by magnitude', () => {
		expect(fmtAmount(0)).toBe('0');
		expect(fmtAmount(0.00001)).toBe('<0.0001');
		expect(fmtAmount(0.5)).toBe('0.500000');
		expect(fmtAmount(12.3456)).toBe('12.3456');
		expect(fmtAmount(12345.678)).toBe('12,345.68');
	});
});

describe('ERC20_ABI', () => {
	it('exposes the six fragments three.ws calls', () => {
		const names = ERC20_ABI.map((f) => f.name).sort();
		expect(names).toEqual(['allowance', 'approve', 'balanceOf', 'decimals', 'symbol', 'transfer']);
	});
});

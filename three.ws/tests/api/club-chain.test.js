// api/_lib/club/chain.js — chainOf network normalization.
//
// Regression guard for the bug where a settled x402 tip stores its network as a
// CAIP-2 id ('solana:5eykt4…' / 'eip155:8453') but the sweep compared against
// the bare chain key ('solana' / 'base'), so every Solana tip fell through to
// the EVM branch and was skipped as "no wallet".

import { describe, it, expect } from 'vitest';
import { chainOf } from '../../api/_lib/club/chain.js';

describe('chainOf', () => {
	it('passes through bare chain keys (bypass-ticket form)', () => {
		expect(chainOf('solana')).toBe('solana');
		expect(chainOf('base')).toBe('base');
	});

	it('collapses CAIP-2 ids to the chain key (settled-x402 form)', () => {
		expect(chainOf('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('solana');
		expect(chainOf('eip155:8453')).toBe('base');
	});

	it('is case- and whitespace-insensitive', () => {
		expect(chainOf('  SOLANA:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp ')).toBe('solana');
		expect(chainOf('EIP155:8453')).toBe('base');
	});

	it('passes unknown networks through unchanged so they surface downstream', () => {
		expect(chainOf('eip155:1')).toBe('eip155:1');
		expect(chainOf('aptos')).toBe('aptos');
	});

	it('treats null/undefined/empty as an empty string', () => {
		expect(chainOf(null)).toBe('');
		expect(chainOf(undefined)).toBe('');
		expect(chainOf('')).toBe('');
	});
});

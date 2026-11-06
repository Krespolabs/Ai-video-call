/**
 * addressMatchesPattern is the server's security gate for adopting a vanity
 * keypair the owner ground in their browser: /api/agents/:id/solana/vanity
 * re-derives the address from the supplied secret_key and refuses to store it
 * unless it actually satisfies the requested prefix/suffix. These tests pin the
 * matching rules — especially the rejection paths, where a bug would let a
 * client assign an address that doesn't match what they claimed.
 */
import { describe, it, expect } from 'vitest';
import { addressMatchesPattern } from '../../api/_lib/pump-vanity.js';

const ADDR = 'AGNTxK9pZqf3mWcVbN1rT7sQ4hLdJ2yUe8gKpRzaBca'; // starts 'AGNT', ends 'Bca'

describe('addressMatchesPattern', () => {
	it('accepts an exact case-sensitive prefix', () => {
		expect(addressMatchesPattern(ADDR, { prefix: 'AGNT' })).toBe(true);
	});

	it('accepts an exact case-sensitive suffix', () => {
		expect(addressMatchesPattern(ADDR, { suffix: 'Bca' })).toBe(true);
	});

	it('accepts a combined prefix + suffix', () => {
		expect(addressMatchesPattern(ADDR, { prefix: 'AGN', suffix: 'ca' })).toBe(true);
	});

	it('rejects a case mismatch when case-sensitive (the security case)', () => {
		// 'agnt' is NOT a prefix of 'AGNT…' unless the owner opted into ignoreCase.
		expect(addressMatchesPattern(ADDR, { prefix: 'agnt' })).toBe(false);
	});

	it('accepts a case mismatch only when ignoreCase is set', () => {
		expect(addressMatchesPattern(ADDR, { prefix: 'agnt', ignoreCase: true })).toBe(true);
		expect(addressMatchesPattern(ADDR, { suffix: 'BCA', ignoreCase: true })).toBe(true);
	});

	it('rejects an address that does not match the claimed pattern', () => {
		expect(addressMatchesPattern(ADDR, { prefix: 'ZZZ' })).toBe(false);
		expect(addressMatchesPattern(ADDR, { suffix: 'xyz' })).toBe(false);
		expect(addressMatchesPattern(ADDR, { prefix: 'AGN', suffix: 'XX' })).toBe(false);
	});

	it('rejects empty/missing patterns and bad input (no silent pass)', () => {
		expect(addressMatchesPattern(ADDR, {})).toBe(false);
		expect(addressMatchesPattern(ADDR, { prefix: '', suffix: '' })).toBe(false);
		expect(addressMatchesPattern('', { prefix: 'AGNT' })).toBe(false);
		expect(addressMatchesPattern(null, { prefix: 'AGNT' })).toBe(false);
	});
});

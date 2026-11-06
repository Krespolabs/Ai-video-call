import { describe, it, expect } from 'vitest';
import { __test__ } from '../../api/x402/animation-download.js';

const { priceAtomics, buildSiwxStatement, buildPayToOverride, UUID_RE } = __test__;

describe('animation-download priceAtomics', () => {
	it('converts a human USDC amount to 6-decimal atomic units', () => {
		expect(priceAtomics('2.5')).toBe('2500000');
		expect(priceAtomics(1)).toBe('1000000');
		expect(priceAtomics('0.01')).toBe('10000');
	});
});

describe('animation-download buildSiwxStatement', () => {
	it('is a single line of EIP-4361-safe characters', () => {
		const s = buildSiwxStatement('Spin Kick "Combo" {v2}');
		expect(s).not.toMatch(/[`{}"]/);
		expect(s.split('\n')).toHaveLength(1);
		expect(s).toContain('Spin Kick');
	});
	it('falls back when the name is empty', () => {
		expect(buildSiwxStatement('')).toMatch(/re-download this animation/);
	});
});

describe('animation-download buildPayToOverride', () => {
	it('includes only the chains a creator has set', () => {
		expect(buildPayToOverride({ creator_payto_base: '0xabc', creator_payto_solana: null, creator_payto_bsc: null }))
			.toEqual({ base: '0xabc' });
	});
	it('returns undefined when no payout is configured (falls back to platform default)', () => {
		expect(buildPayToOverride({ creator_payto_base: null, creator_payto_solana: null, creator_payto_bsc: null }))
			.toBeUndefined();
	});
});

describe('animation-download UUID guard', () => {
	it('accepts a uuid and rejects junk', () => {
		expect(UUID_RE.test('11111111-2222-3333-4444-555555555555')).toBe(true);
		expect(UUID_RE.test('../../etc/passwd')).toBe(false);
		expect(UUID_RE.test('spin-kick')).toBe(false);
	});
});

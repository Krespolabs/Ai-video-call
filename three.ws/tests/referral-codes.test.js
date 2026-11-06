/**
 * Custom referral codes — pure-helper unit tests.
 *
 * Covers the case-insensitive normalization, name → default-code slugging, the
 * candidate generator (name-first, then suffixed, then random), reserved-code
 * blocking, and the canonical-shape regex. These helpers gate every referral
 * lookup and the customize-your-code editor, so they're worth pinning down
 * without a database.
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeReferralCode,
	slugifyReferralName,
	isReservedReferralCode,
	referralCodeCandidates,
	REFERRAL_CODE_RE,
	REFERRAL_CODE_MIN_LEN,
	REFERRAL_CODE_MAX_LEN,
} from '../api/_lib/referrals.js';

describe('normalizeReferralCode', () => {
	it('uppercases and trims valid codes', () => {
		expect(normalizeReferralCode('  catherine ')).toBe('CATHERINE');
		expect(normalizeReferralCode('Ada99')).toBe('ADA99');
	});

	it('rejects codes with spaces, symbols, or hyphens (no silent mangling)', () => {
		expect(normalizeReferralCode('my-code')).toBeNull();
		expect(normalizeReferralCode('hi there')).toBeNull();
		expect(normalizeReferralCode('coin$')).toBeNull();
	});

	it('enforces length bounds', () => {
		expect(normalizeReferralCode('ab')).toBeNull(); // too short
		expect(normalizeReferralCode('a'.repeat(REFERRAL_CODE_MAX_LEN + 1))).toBeNull();
		expect(normalizeReferralCode('a'.repeat(REFERRAL_CODE_MIN_LEN))).toBe('AAA');
	});

	it('handles nullish input', () => {
		expect(normalizeReferralCode(null)).toBeNull();
		expect(normalizeReferralCode(undefined)).toBeNull();
		expect(normalizeReferralCode('')).toBeNull();
	});
});

describe('slugifyReferralName', () => {
	it('derives a canonical code from a person name', () => {
		expect(slugifyReferralName('Catherine Maerial')).toBe('CATHERINEMAERIAL');
		expect(slugifyReferralName('María José')).toBe('MARIAJOSE'); // accent-folded
	});

	it('clamps to the max length', () => {
		const slug = slugifyReferralName('a'.repeat(40));
		expect(slug.length).toBe(REFERRAL_CODE_MAX_LEN);
	});

	it('returns null when nothing usable remains', () => {
		expect(slugifyReferralName('!!')).toBeNull();
		expect(slugifyReferralName('')).toBeNull();
		expect(slugifyReferralName(null)).toBeNull();
	});
});

describe('isReservedReferralCode', () => {
	it('blocks platform/route codes case-insensitively', () => {
		expect(isReservedReferralCode('admin')).toBe(true);
		expect(isReservedReferralCode('ADMIN')).toBe(true);
		expect(isReservedReferralCode('three')).toBe(true);
		expect(isReservedReferralCode('catherine')).toBe(false);
	});
});

describe('referralCodeCandidates', () => {
	it('offers the name slug first', () => {
		const first = referralCodeCandidates('Ada Lovelace').next().value;
		expect(first).toBe('ADALOVELACE');
	});

	it('falls back to suffixed then random when the name is unusable', () => {
		const codes = [...referralCodeCandidates('!!')];
		expect(codes.length).toBeGreaterThan(0);
		for (const c of codes) expect(REFERRAL_CODE_RE.test(c)).toBe(true);
	});

	it('never offers a reserved name slug as the bare default', () => {
		const codes = [...referralCodeCandidates('admin')];
		expect(codes).not.toContain('ADMIN');
		for (const c of codes) expect(REFERRAL_CODE_RE.test(c)).toBe(true);
	});

	it('yields only unique, in-bounds candidates', () => {
		const codes = [...referralCodeCandidates('Bo')]; // short name → mostly random
		expect(new Set(codes).size).toBe(codes.length);
		for (const c of codes) {
			expect(c.length).toBeLessThanOrEqual(REFERRAL_CODE_MAX_LEN);
			expect(c.length).toBeGreaterThanOrEqual(REFERRAL_CODE_MIN_LEN);
		}
	});
});

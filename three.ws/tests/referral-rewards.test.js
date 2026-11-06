/**
 * Referral activation rewards + viral-funnel math — pure-helper unit tests.
 *
 * Covers the env-config parser (defaults, clamps, disable flag), the k-factor
 * and conversion-rate formulas (the numbers the growth dashboard reports), and
 * the privacy-preserving visitor hash (stable, code-sensitive, non-reversible).
 * These gate real credit grants and the loop's headline metric, so they're
 * pinned down without a database.
 */

import { describe, it, expect } from 'vitest';
import {
	parseRewardConfig,
	computeKFactor,
	conversionRate,
	referralVisitorHash,
} from '../api/_lib/referral-rewards.js';

describe('parseRewardConfig', () => {
	it('uses sane defaults for an empty env', () => {
		const c = parseRewardConfig({});
		expect(c.enabled).toBe(true);
		expect(c.referredUsd).toBe(1.0);
		expect(c.referrerUsd).toBe(2.0);
		expect(c.monthlyCap).toBe(200);
	});

	it('reads overrides', () => {
		const c = parseRewardConfig({
			REFERRAL_REFERRED_REWARD_USD: '2.5',
			REFERRAL_REFERRER_REWARD_USD: '5',
			REFERRAL_ACTIVATION_MONTHLY_CAP: '50',
		});
		expect(c.referredUsd).toBe(2.5);
		expect(c.referrerUsd).toBe(5);
		expect(c.monthlyCap).toBe(50);
	});

	it('disables only on the explicit false flag', () => {
		expect(parseRewardConfig({ REFERRAL_REWARDS_ENABLED: 'false' }).enabled).toBe(false);
		expect(parseRewardConfig({ REFERRAL_REWARDS_ENABLED: 'FALSE' }).enabled).toBe(false);
		expect(parseRewardConfig({ REFERRAL_REWARDS_ENABLED: 'true' }).enabled).toBe(true);
		expect(parseRewardConfig({ REFERRAL_REWARDS_ENABLED: '' }).enabled).toBe(true);
	});

	it('falls back to the default for negative / garbage amounts', () => {
		const c = parseRewardConfig({
			REFERRAL_REFERRED_REWARD_USD: '-1',
			REFERRAL_REFERRER_REWARD_USD: 'abc',
			REFERRAL_ACTIVATION_MONTHLY_CAP: '-5',
		});
		expect(c.referredUsd).toBe(1.0);
		expect(c.referrerUsd).toBe(2.0);
		expect(c.monthlyCap).toBe(200);
	});

	it('clamps absurd amounts to the ceiling so a fat-fingered env cannot mint a fortune', () => {
		const c = parseRewardConfig({
			REFERRAL_REFERRED_REWARD_USD: '999999',
			REFERRAL_REFERRER_REWARD_USD: '500',
		});
		expect(c.referredUsd).toBe(100);
		expect(c.referrerUsd).toBe(100);
	});

	it('allows a zero reward (one side off)', () => {
		const c = parseRewardConfig({ REFERRAL_REFERRED_REWARD_USD: '0' });
		expect(c.referredUsd).toBe(0);
	});
});

describe('computeKFactor', () => {
	it('is signups per sharing user', () => {
		expect(computeKFactor({ signups: 30, sharers: 10 })).toBe(3);
		expect(computeKFactor({ signups: 5, sharers: 10 })).toBe(0.5);
	});

	it('is 0 when nobody shared (no divide-by-zero)', () => {
		expect(computeKFactor({ signups: 10, sharers: 0 })).toBe(0);
		expect(computeKFactor({ signups: 0, sharers: 0 })).toBe(0);
	});

	it('rounds to 3 decimals', () => {
		expect(computeKFactor({ signups: 1, sharers: 3 })).toBe(0.333);
	});

	it('tolerates missing / non-numeric inputs', () => {
		expect(computeKFactor({})).toBe(0);
		expect(computeKFactor({ signups: 'x', sharers: 'y' })).toBe(0);
	});
});

describe('conversionRate', () => {
	it('is a 0..1 ratio rounded to 3 decimals', () => {
		expect(conversionRate(50, 100)).toBe(0.5);
		expect(conversionRate(1, 3)).toBe(0.333);
	});

	it('is 0 when the denominator is 0', () => {
		expect(conversionRate(10, 0)).toBe(0);
		expect(conversionRate(0, 0)).toBe(0);
	});
});

describe('referralVisitorHash', () => {
	it('is a 64-char hex sha256', () => {
		const h = referralVisitorHash({ ip: '1.2.3.4', ua: 'Mozilla', code: 'ADA' });
		expect(h).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is stable for the same inputs (dedup works)', () => {
		const a = referralVisitorHash({ ip: '1.2.3.4', ua: 'UA', code: 'ADA' });
		const b = referralVisitorHash({ ip: '1.2.3.4', ua: 'UA', code: 'ADA' });
		expect(a).toBe(b);
	});

	it('is case-insensitive on the code (matches canonical storage)', () => {
		const a = referralVisitorHash({ ip: '1.2.3.4', ua: 'UA', code: 'ada' });
		const b = referralVisitorHash({ ip: '1.2.3.4', ua: 'UA', code: 'ADA' });
		expect(a).toBe(b);
	});

	it('differs by code so one visitor on two links counts twice', () => {
		const a = referralVisitorHash({ ip: '1.2.3.4', ua: 'UA', code: 'ADA' });
		const b = referralVisitorHash({ ip: '1.2.3.4', ua: 'UA', code: 'BOB' });
		expect(a).not.toBe(b);
	});

	it('differs by visitor (ip/ua) so two people on one link count twice', () => {
		const a = referralVisitorHash({ ip: '1.2.3.4', ua: 'UA', code: 'ADA' });
		const b = referralVisitorHash({ ip: '9.9.9.9', ua: 'UA', code: 'ADA' });
		expect(a).not.toBe(b);
	});

	it('tolerates missing fields', () => {
		expect(referralVisitorHash({ code: 'ADA' })).toMatch(/^[0-9a-f]{64}$/);
	});
});

import { describe, it, expect } from 'vitest';

const { __test } = await import('../api/_lib/x402/pipelines/subscription-health.js');
const { classify, contactEmail, EXPIRY_WARN_DAYS } = __test;

const NOW = Date.parse('2026-06-27T00:00:00Z');
const inDays = (n) => new Date(NOW + n * 86_400_000).toISOString();

describe('subscription-health classify()', () => {
	it('flags a revoked key regardless of expiry', () => {
		const v = classify({ revoked_at: inDays(-1), expires_at: inDays(100) }, NOW);
		expect(v.status).toBe('revoked');
		expect(v.daysToExpiry).toBeNull();
	});

	it('treats a null expiry as active with no countdown', () => {
		const v = classify({ revoked_at: null, expires_at: null }, NOW);
		expect(v.status).toBe('active');
		expect(v.daysToExpiry).toBeNull();
	});

	it('marks an already-past expiry as expired', () => {
		const v = classify({ expires_at: inDays(-2) }, NOW);
		expect(v.status).toBe('expired');
		expect(v.daysToExpiry).toBeLessThanOrEqual(0);
	});

	it('marks a key inside the warning window as expiring_soon', () => {
		const v = classify({ expires_at: inDays(3) }, NOW);
		expect(v.status).toBe('expiring_soon');
		expect(v.daysToExpiry).toBe(3);
	});

	it('marks a key at the warning boundary as expiring_soon', () => {
		const v = classify({ expires_at: inDays(EXPIRY_WARN_DAYS) }, NOW);
		expect(v.status).toBe('expiring_soon');
	});

	it('marks a key beyond the warning window as active', () => {
		const v = classify({ expires_at: inDays(EXPIRY_WARN_DAYS + 5) }, NOW);
		expect(v.status).toBe('active');
		expect(v.daysToExpiry).toBe(EXPIRY_WARN_DAYS + 5);
	});
});

describe('subscription-health contactEmail()', () => {
	it('returns null when meta is missing or has no contact', () => {
		expect(contactEmail(null)).toBeNull();
		expect(contactEmail({})).toBeNull();
		expect(contactEmail({ tier: 'gold' })).toBeNull();
	});

	it('reads the common contact keys', () => {
		expect(contactEmail({ email: 'a@b.com' })).toBe('a@b.com');
		expect(contactEmail({ contact_email: 'c@d.io' })).toBe('c@d.io');
		expect(contactEmail({ notify_email: 'e@f.dev' })).toBe('e@f.dev');
		expect(contactEmail({ contact: 'g@h.net' })).toBe('g@h.net');
		expect(contactEmail({ contact: { email: 'i@j.org' } })).toBe('i@j.org');
	});

	it('rejects a malformed address', () => {
		expect(contactEmail({ email: 'not-an-email' })).toBeNull();
		expect(contactEmail({ email: '  ' })).toBeNull();
	});

	it('trims surrounding whitespace', () => {
		expect(contactEmail({ email: '  k@l.com  ' })).toBe('k@l.com');
	});
});

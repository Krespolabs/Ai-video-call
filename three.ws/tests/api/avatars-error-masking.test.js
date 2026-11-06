// Verifies the avatar pipeline never leaks provider internals to the client:
// the submit-error classifier and the job-error sanitizer must translate every
// vendor name, billing state, and raw upstream string into neutral copy while
// preserving the error CODE the UIs branch on.

import { describe, it, expect } from 'vitest';
import { classifyProviderError, sanitizeJobError } from '../../api/avatars/_actions.js';

// Raw provider error strings as actually thrown by the Meshy/Tripo adapters and
// returned in job status — none of these substrings may survive to the client.
const VENDOR_LEAKS = [
	'Meshy account is out of credits.',
	'Meshy rejected the API key.',
	'Tripo account is out of credits.',
	'Tripo is rate limiting this key.',
	'meshy task not found',
	'meshy returned 500',
	'tripo poll failed: ECONNREFUSED 10.0.0.1:443',
	'unknown AVATAR_REGEN_PROVIDER: replicate-experimental',
	'https://platform.stability.ai/account/billing',
];

describe('classifyProviderError — preserves code, masks message', () => {
	it.each([
		['insufficient_credits', 402, 'insufficient_credits'],
		['invalid_key', 401, 'invalid_key'],
		['missing_key', 401, 'missing_key'],
		['rate_limited', 429, 'rate_limited'],
		['invalid_request', 400, 'invalid_request'],
		['mode_unconfigured', 501, 'regen_unconfigured'],
		['regen_provider_unknown', 501, 'regen_unconfigured'],
		['provider_unreachable', 502, 'regen_provider_error'],
		['provider_error', 502, 'regen_provider_error'],
	])('code %s → status %d / client-code %s', (code, status, outCode) => {
		const out = classifyProviderError({ code, message: 'Meshy account is out of credits. https://meshy.ai/billing', status });
		expect(out.status).toBe(status);
		expect(out.code).toBe(outCode);
	});

	it('falls back by HTTP status when no code is present', () => {
		expect(classifyProviderError({ status: 402 }).code).toBe('insufficient_credits');
		expect(classifyProviderError({ status: 401 }).code).toBe('invalid_key');
		expect(classifyProviderError({ status: 429 }).code).toBe('rate_limited');
		expect(classifyProviderError({}).code).toBe('regen_provider_error');
	});

	it('never echoes a vendor name, billing wording, IP, or URL in the message', () => {
		for (const raw of VENDOR_LEAKS) {
			const { message } = classifyProviderError({ message: raw, code: 'provider_error', status: 502 });
			expect(message).not.toMatch(/meshy|tripo|stability|replicate/i);
			expect(message).not.toMatch(/https?:\/\//);
			expect(message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
			expect(message).not.toMatch(/credit|billing|api key/i);
		}
	});

	it('rate-limit carries a retry hint', () => {
		expect(classifyProviderError({ code: 'rate_limited' }).retryAfter).toBe(15);
	});
});

describe('sanitizeJobError — neutralizes raw job/provider strings', () => {
	it('returns null for empty input', () => {
		expect(sanitizeJobError(null)).toBeNull();
		expect(sanitizeJobError('')).toBeNull();
		expect(sanitizeJobError(undefined)).toBeNull();
	});

	it.each([
		['NSFW content detected by safety classifier', /content safety/i],
		['no face found in input image', /face/i],
		['CUDA out of memory (OOM) on device 0', /resources/i],
		['upstream request timed out after 300s', /too long|try again/i],
		['account has insufficient credit balance, see billing', /temporarily unavailable/i],
		['429 rate limit exceeded for key sk_live_xxx', /busy/i],
	])('maps %s → friendly copy', (raw, expected) => {
		const out = sanitizeJobError(raw);
		expect(out).toMatch(expected);
	});

	it('never leaks vendor names, keys, IPs, or URLs', () => {
		for (const raw of [
			...VENDOR_LEAKS,
			'meshy task failed: GPU node i-0abc123 oom at https://meshy.ai/tasks/xyz',
			'sk_live_secret_key_leaked rate limit',
		]) {
			const out = sanitizeJobError(raw) || '';
			expect(out).not.toMatch(/meshy|tripo|stability|replicate/i);
			expect(out).not.toMatch(/https?:\/\//);
			expect(out).not.toMatch(/sk_live|i-0abc/);
		}
	});
});

// Verifies the avatar submit resilience layer: a transient infra fault (network
// drop, upstream 5xx, cold start) is retried once against the same provider, so
// a single hiccup no longer dead-ends a reconstruct/regenerate job — while
// deterministic faults (bad key, no credits, bad input, a provider 4xx) fail
// fast without a wasted retry or double charge.

import { describe, it, expect, vi } from 'vitest';
import { isTransientProviderError, submitWithTransientRetry } from '../../api/avatars/_actions.js';

const err = (props) => Object.assign(new Error(props.message || 'x'), props);

describe('isTransientProviderError — only infra faults retry', () => {
	it.each([
		['provider_unreachable', { code: 'provider_unreachable', status: 502 }],
		['provider_timeout', { code: 'provider_timeout', status: 504 }],
		['provider_error with no upstream status', { code: 'provider_error', status: 502 }],
		['provider_error with upstream 500', { code: 'provider_error', status: 502, providerStatus: 500 }],
		['provider_error with upstream 503', { code: 'provider_error', status: 502, providerStatus: 503 }],
		['bare 503 envelope', { status: 503 }],
		['bare 504 envelope', { status: 504 }],
	])('transient: %s', (_label, props) => {
		expect(isTransientProviderError(err(props))).toBe(true);
	});

	it.each([
		['insufficient_credits', { code: 'insufficient_credits', status: 402 }],
		['invalid_key', { code: 'invalid_key', status: 401 }],
		['rate_limited', { code: 'rate_limited', status: 429 }],
		['invalid_request', { code: 'invalid_request', status: 400 }],
		['mode_unconfigured', { code: 'mode_unconfigured', status: 501 }],
		['provider_error with upstream 422', { code: 'provider_error', status: 502, providerStatus: 422 }],
		['provider_error with upstream 400', { code: 'provider_error', status: 502, providerStatus: 400 }],
		['null', null],
	])('deterministic: %s', (_label, props) => {
		expect(isTransientProviderError(props ? err(props) : null)).toBe(false);
	});
});

describe('submitWithTransientRetry — one retry on transient, none on deterministic', () => {
	it('retries once and succeeds after a transient failure', async () => {
		const submit = vi
			.fn()
			.mockRejectedValueOnce(err({ code: 'provider_unreachable', status: 502 }))
			.mockResolvedValueOnce({ extJobId: 'job-123', eta: 60 });
		const out = await submitWithTransientRetry({ submit }, { mode: 'reconstruct' });
		expect(out.extJobId).toBe('job-123');
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it('does not retry a deterministic failure — fails fast', async () => {
		const submit = vi.fn().mockRejectedValue(err({ code: 'insufficient_credits', status: 402 }));
		await expect(submitWithTransientRetry({ submit }, {})).rejects.toMatchObject({
			code: 'insufficient_credits',
		});
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it('surfaces the second error when the retry also fails transiently', async () => {
		const submit = vi
			.fn()
			.mockRejectedValueOnce(err({ code: 'provider_unreachable', status: 502 }))
			.mockRejectedValueOnce(err({ code: 'provider_error', status: 502, message: 'still down' }));
		await expect(submitWithTransientRetry({ submit }, {})).rejects.toMatchObject({
			code: 'provider_error',
		});
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it('passes the request through unchanged on the first attempt', async () => {
		const submit = vi.fn().mockResolvedValue({ extJobId: 'ok' });
		const request = { userId: 'u1', mode: 'reconstruct', sourceUrl: 'https://x/img.png' };
		await submitWithTransientRetry({ submit }, request);
		expect(submit).toHaveBeenCalledTimes(1);
		expect(submit).toHaveBeenCalledWith(request);
	});
});

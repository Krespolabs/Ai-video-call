// The buyer-facing error path of the paid Forge x402 endpoint must NEVER relay a
// vendor's billing/credit/quota text, a raw 5xx body, or a vendor URL — that's
// our internal infra state (a hard /CLAUDE.md rule). These prove the masking:
// neutral, actionable copy reaches the client while the raw detail only goes to
// the server log. Submit runs before settle, so each masked message can honestly
// promise the payment was not taken.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { respondGenerationError, isPaidCreditFailure } from '../api/x402/forge.js';

// Minimal res double — captures what json()/error() write without real HTTP.
function mockRes() {
	return {
		statusCode: 0,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(payload) {
			this.writableEnded = true;
			this.body = payload ? JSON.parse(payload) : null;
		},
	};
}

// Vendor strings that have actually leaked from upstream generators — none of
// these substrings may appear in a buyer-facing response.
const VENDOR_LEAKS = [
	'insufficient credit',
	'purchase credit',
	'api.meshy.ai',
	'replicate.com',
	'billing',
	'quota',
	'401',
	'api key',
];

function assertNoLeak(res) {
	const text = JSON.stringify(res.body).toLowerCase();
	for (const leak of VENDOR_LEAKS) {
		expect(text, `must not leak "${leak}"`).not.toContain(leak.toLowerCase());
	}
}

describe('respondGenerationError — vendor billing is never relayed', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('masks a vendor credit/billing 5xx to neutral, payment-safe copy', () => {
		const res = mockRes();
		respondGenerationError(res, {
			status: 502,
			providerStatus: 402,
			message: 'Replicate: insufficient credit to run this model — purchase credit at replicate.com/account/billing',
		});
		// Credit failures route to the dedicated 503 "temporarily unavailable" copy.
		expect(res.statusCode).toBe(503);
		expect(res.body.error).toBe('generation_unavailable');
		expect(res.body.error_description).toMatch(/payment was not taken/i);
		assertNoLeak(res);
	});

	it('masks a generic vendor 5xx (raw upstream body) to neutral copy', () => {
		const res = mockRes();
		respondGenerationError(res, {
			status: 502,
			message: 'Meshy API error 500: {"detail":"upstream failure"} https://api.meshy.ai/v2/text-to-3d',
		});
		expect(res.statusCode).toBe(502);
		expect(res.body.error).toBe('generation_failed');
		expect(res.body.error_description).toMatch(/payment was not taken|retry/i);
		assertNoLeak(res);
	});

	it('masks a 429 throttle without echoing the vendor account credit balance', () => {
		const res = mockRes();
		respondGenerationError(res, {
			status: 429,
			code: 'rate_limited',
			retryAfter: 7,
			message: 'Rate limited: account credit low (2 credits remaining), purchase credit',
		});
		expect(res.statusCode).toBe(429);
		expect(res.headers['retry-after']).toBe('7');
		expect(res.body.error_description).toMatch(/payment was not taken/i);
		assertNoLeak(res);
	});

	it('still surfaces a safe 4xx client-input message (bad prompt)', () => {
		const res = mockRes();
		respondGenerationError(res, {
			status: 400,
			code: 'invalid_prompt',
			message: 'prompt must be a non-empty string',
		});
		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('invalid_prompt');
		// A 4xx is a client fault with a safe, actionable message — keep it verbatim.
		expect(res.body.error_description).toBe('prompt must be a non-empty string');
	});
});

describe('isPaidCreditFailure', () => {
	it('detects a provider 402 and common credit/billing phrasings', () => {
		expect(isPaidCreditFailure({ providerStatus: 402 })).toBe(true);
		expect(isPaidCreditFailure({ message: 'insufficient credit to run' })).toBe(true);
		expect(isPaidCreditFailure({ providerDetail: 'please purchase credit' })).toBe(true);
		expect(isPaidCreditFailure({ message: 'out of credit' })).toBe(true);
	});

	it('does not flag an ordinary failure', () => {
		expect(isPaidCreditFailure({ message: 'timeout waiting for reconstruction' })).toBe(false);
		expect(isPaidCreditFailure({})).toBe(false);
	});
});

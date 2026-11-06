// Unit tests for isRpcRateLimited — the classifier that keeps a Helius 429
// out of error-level alerting on the $THREE holder-snapshot cron.
//
// Regression target: a Helius rate limit surfaces as a @solana/kit SolanaError
// whose human-readable message is stripped in prod builds — "Solana error
// #8100002; Decode this error by running `npx @solana/errors decode -- 8100002
// '<base64>'`". That string contains neither "429" nor "rate limit", so the
// snapshot cron's text-only transient check misclassified it as an ERROR and
// fired a per-tick page (143 of them in one production log export). The fix
// inspects the structured statusCode the error carries at runtime.

import { describe, it, expect } from 'vitest';
import { isRpcRateLimited } from '../api/_lib/coin/holders.js';

describe('isRpcRateLimited', () => {
	it('detects a SolanaError whose message is stripped but context.statusCode is 429', () => {
		// What @solana/kit actually throws in a production build on a Helius 429.
		const err = Object.assign(
			new Error("Solana error #8100002; Decode this error by running `npx @solana/errors decode -- 8100002 'X19jb2RlPTgx'`"),
			{ context: { __code: 8100002, statusCode: 429 } },
		);
		expect(isRpcRateLimited(err)).toBe(true);
	});

	it('detects a plain error with a 429 status field', () => {
		expect(isRpcRateLimited(Object.assign(new Error('boom'), { status: 429 }))).toBe(true);
		expect(isRpcRateLimited(Object.assign(new Error('boom'), { statusCode: 429 }))).toBe(true);
	});

	it('detects the verbatim provider bodies that only surface as a message string', () => {
		expect(isRpcRateLimited(new Error('Too Many Requests'))).toBe(true);
		expect(isRpcRateLimited(new Error('upstream 429: {"error":{"message":"max usage reached"}}'))).toBe(true);
		expect(isRpcRateLimited(new Error('rate limit exceeded'))).toBe(true);
	});

	it('does NOT flag unrelated faults (so genuine bugs still page)', () => {
		expect(isRpcRateLimited(new Error('Solana error #4615000; account not found'))).toBe(false);
		expect(isRpcRateLimited(Object.assign(new Error('server error'), { statusCode: 500 }))).toBe(false);
		expect(isRpcRateLimited(new Error('ECONNRESET'))).toBe(false);
	});

	it('is null/shape safe', () => {
		expect(isRpcRateLimited(null)).toBe(false);
		expect(isRpcRateLimited(undefined)).toBe(false);
		expect(isRpcRateLimited('429')).toBe(false); // strings aren't error objects
		expect(isRpcRateLimited({})).toBe(false);
	});
});

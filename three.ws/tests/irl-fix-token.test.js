// Proof-of-presence token mint/verify (epic IRL-Hardening H3).
//
// Regression fence for the production incident where POST /api/irl/fix-token 500'd
// on every request with `DataError: Zero-length key is not supported`: minting ran
// hmacSha256() with an empty key whenever IRL_FIX_SECRET was unset (every dev/preview
// box AND a misconfigured prod). The mint path must work without a configured secret
// — that's the documented dev/preview contract — and must never hand a zero-length
// key to Web Crypto. These tests pin both the no-secret (bypass) and configured
// (enforced) modes, plus the forgery/expiry/area rejections that make the token a
// real proof rather than a rubber stamp.

import { describe, it, expect, afterEach } from 'vitest';

import {
	mintFixToken,
	verifyFixToken,
	fixEnforced,
	FIX_TTL_SEC,
} from '../api/_lib/irl-presence.js';
import { hmacSha256 } from '../api/_lib/crypto.js';

// A point somewhere ordinary (San Francisco) for coordinate assertions.
const LAT = 37.7749;
const LNG = -122.4194;
const NOW = 1_700_000_000; // fixed issuance clock so expiry math is deterministic.

const STRONG_SECRET = 'a-strong-32-char-minimum-secret-value';

// Each test sets process.env.IRL_FIX_SECRET as needed; always restore it so tests
// don't leak enforcement mode into one another.
const ORIGINAL = process.env.IRL_FIX_SECRET;
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.IRL_FIX_SECRET;
	else process.env.IRL_FIX_SECRET = ORIGINAL;
});

describe('mintFixToken — never crashes on a zero-length key', () => {
	it('mints a usable token when IRL_FIX_SECRET is UNSET (dev/preview bypass)', async () => {
		delete process.env.IRL_FIX_SECRET;
		expect(fixEnforced()).toBe(false);
		// The exact call that used to throw `Zero-length key is not supported`.
		const minted = await mintFixToken(LAT, LNG, NOW);
		expect(minted).toBeTruthy();
		expect(typeof minted.token).toBe('string');
		expect(minted.token).toContain('.');
		expect(minted.expires_in).toBe(FIX_TTL_SEC);
		expect(typeof minted.cell).toBe('string');
		// And it round-trips in the same mode (mint + verify share the dev key).
		const v = await verifyFixToken(minted.token, LAT, LNG, NOW);
		expect(v.ok).toBe(true);
	});

	it('mints a usable token when IRL_FIX_SECRET is set but too WEAK (<16 chars)', async () => {
		process.env.IRL_FIX_SECRET = 'short';
		expect(fixEnforced()).toBe(false);
		const minted = await mintFixToken(LAT, LNG, NOW);
		expect(minted).toBeTruthy();
		const v = await verifyFixToken(minted.token, LAT, LNG, NOW);
		expect(v.ok).toBe(true);
	});

	it('mints and round-trips with a STRONG configured secret (production mode)', async () => {
		process.env.IRL_FIX_SECRET = STRONG_SECRET;
		expect(fixEnforced()).toBe(true);
		const minted = await mintFixToken(LAT, LNG, NOW);
		const v = await verifyFixToken(minted.token, LAT, LNG, NOW);
		expect(v.ok).toBe(true);
		expect(v.cell).toBe(minted.cell);
	});

	it('returns null (not a throw) for an unplaceable fix', async () => {
		delete process.env.IRL_FIX_SECRET;
		expect(await mintFixToken(NaN, LNG, NOW)).toBeNull();
		expect(await mintFixToken(LAT, Infinity, NOW)).toBeNull();
		expect(await mintFixToken(91, LNG, NOW)).toBeNull();   // lat out of range
		expect(await mintFixToken(LAT, 181, NOW)).toBeNull();  // lng out of range
	});
});

describe('verifyFixToken — a real proof, not a rubber stamp', () => {
	it('rejects a tampered signature as forged', async () => {
		process.env.IRL_FIX_SECRET = STRONG_SECRET;
		const { token } = await mintFixToken(LAT, LNG, NOW);
		const dot = token.indexOf('.');
		const sig = token.slice(dot + 1);
		// Flip the final signature char to a definitely-different one (same length).
		const flipped = sig.at(-1) === 'A' ? 'B' : 'A';
		const forged = token.slice(0, dot + 1) + sig.slice(0, -1) + flipped;
		const v = await verifyFixToken(forged, LAT, LNG, NOW);
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('forged');
	});

	it('rejects a read claimed far from the mint anchor (out_of_area)', async () => {
		process.env.IRL_FIX_SECRET = STRONG_SECRET;
		const { token } = await mintFixToken(LAT, LNG, NOW);
		// ~1.1 km north — well past FIX_TOLERANCE_M (250 m).
		const v = await verifyFixToken(token, LAT + 0.01, LNG, NOW);
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('out_of_area');
	});

	it('rejects an expired token', async () => {
		process.env.IRL_FIX_SECRET = STRONG_SECRET;
		const { token } = await mintFixToken(LAT, LNG, NOW);
		const v = await verifyFixToken(token, LAT, LNG, NOW + FIX_TTL_SEC + 10);
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('expired');
	});

	it('reports missing / malformed inputs without throwing', async () => {
		process.env.IRL_FIX_SECRET = STRONG_SECRET;
		expect((await verifyFixToken('', LAT, LNG, NOW)).reason).toBe('missing');
		expect((await verifyFixToken('no-dot-here', LAT, LNG, NOW)).reason).toBe('malformed');
	});

	it('a token minted in bypass mode is rejected once enforcement is live (no backdoor)', async () => {
		// Mint with no secret (dev fallback key)…
		delete process.env.IRL_FIX_SECRET;
		const { token } = await mintFixToken(LAT, LNG, NOW);
		// …then turn enforcement on. The dev-key signature must not satisfy the real key.
		process.env.IRL_FIX_SECRET = STRONG_SECRET;
		const v = await verifyFixToken(token, LAT, LNG, NOW);
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('forged');
	});
});

describe('hmacSha256 — clear error on an empty key', () => {
	it('throws a diagnosable message instead of an opaque DataError', async () => {
		await expect(hmacSha256('', 'msg')).rejects.toThrow(/empty signing key/i);
		await expect(hmacSha256(undefined, 'msg')).rejects.toThrow(/empty signing key/i);
	});

	it('still signs normally with a real key', async () => {
		const sig = await hmacSha256('k', 'msg');
		expect(typeof sig).toBe('string');
		expect(sig.length).toBeGreaterThan(0);
	});
});

// Small crypto helpers that work in both Node and edge runtimes.

import { webcrypto } from 'node:crypto';

const subtle = globalThis.crypto?.subtle || webcrypto.subtle;
const randomBytes = (n) => {
	const b = new Uint8Array(n);
	(globalThis.crypto || webcrypto).getRandomValues(b);
	return b;
};

export function randomToken(bytes = 32) {
	return base64url(randomBytes(bytes));
}

// Cryptographically-secure zero-padded numeric code (e.g. for email
// verification). Uses rejection sampling over the CSPRNG so the distribution is
// uniform (no modulo bias) and unpredictable — never Math.random(), whose output
// is guessable and reduces the effective keyspace well below 10**digits.
export function randomDigits(digits = 6) {
	const max = 10 ** digits;
	const limit = Math.floor(0xffffffff / max) * max; // reject above to kill bias
	let n;
	do {
		const b = randomBytes(4);
		n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
	} while (n >= limit);
	return (n % max).toString().padStart(digits, '0');
}

export async function sha256(input) {
	const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	const hash = await subtle.digest('SHA-256', data);
	return hex(new Uint8Array(hash));
}

export async function sha256Base64Url(input) {
	const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	const hash = await subtle.digest('SHA-256', data);
	return base64url(new Uint8Array(hash));
}

// Length-independent constant-time string compare. We deliberately do NOT
// early-return on a length mismatch — that branch is a timing oracle that
// leaks the secret's length. Instead we fold the length difference into the
// accumulator and iterate over the longer string, reading 0 past the end of
// either operand so the loop count never reveals which side is the secret.
export function constantTimeEquals(a, b) {
	const aStr = String(a);
	const bStr = String(b);
	let r = aStr.length ^ bStr.length;
	const len = aStr.length > bStr.length ? aStr.length : bStr.length;
	for (let i = 0; i < len; i++) {
		const ca = i < aStr.length ? aStr.charCodeAt(i) : 0;
		const cb = i < bStr.length ? bStr.charCodeAt(i) : 0;
		r |= ca ^ cb;
	}
	return r === 0;
}

export async function hmacSha256(secret, message) {
	const keyBytes = new TextEncoder().encode(secret == null ? '' : String(secret));
	// Web Crypto rejects a zero-length HMAC key with an opaque
	// `DataError: Zero-length key is not supported`, thrown deep inside importKey.
	// Surface the real cause — a signing secret that is unset/empty — so the failure
	// is diagnosable from one log line instead of a cryptic crypto stack trace.
	if (keyBytes.length === 0) {
		throw new Error('hmacSha256: empty signing key — a required secret is unset (check environment configuration)');
	}
	const key = await subtle.importKey(
		'raw',
		keyBytes,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await subtle.sign('HMAC', key, new TextEncoder().encode(message));
	return base64url(new Uint8Array(sig));
}

function hex(u8) {
	return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(u8) {
	let s = '';
	for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
	return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

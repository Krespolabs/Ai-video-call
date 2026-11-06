// Solana vanity address generator for pump.fun mint Keypairs.
//
// Vendored from nirholas/solana-wallet-toolkit (MIT) — TypeScript reference
// at typescript/src/lib/{generator,matcher,validation}.ts. Rewritten as a
// single JS module so it works inside Vercel's serverless runtime without
// a transpile step. Adds prefix + suffix + ignoreCase + async yielding so
// long prefixes don't block the event loop while we wait.

import { Keypair } from '@solana/web3.js';

// Solana base58 alphabet — excludes 0, O, I, l to avoid look-alikes.
export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_CHARS = new Set(BASE58_ALPHABET);

const MAX_PATTERN_LENGTH = 6;
const DEFAULT_MAX_ITERATIONS = 2_000_000;
const YIELD_EVERY = 10_000;
// How often (in attempts) onProgress fires. Aligned to a yield boundary so a
// sample is emitted right after the loop hands control back to the event loop —
// the live grind runner turns each sample into one screen frame, then throttles
// its own pushes (~4/sec) to respect the frame TTL and Redis quota.
const PROGRESS_EVERY = 25_000;
// Wall-clock deadline is checked more often than we yield so a maxMs budget
// overshoots by at most ~this-many keypairs (a fraction of a second) instead of
// a full YIELD_EVERY block — keeps a serverless grind well inside maxDuration.
const TIME_CHECK_EVERY = 2_000;

function validatePattern(pattern, label) {
	if (typeof pattern !== 'string' || pattern.length === 0) {
		throw vanityError('invalid_vanity', `${label} must be a non-empty string`);
	}
	if (pattern !== pattern.trim()) {
		throw vanityError('invalid_vanity', `${label} contains whitespace`);
	}
	if (pattern.length > MAX_PATTERN_LENGTH) {
		throw vanityError(
			'invalid_vanity',
			`${label} length ${pattern.length} exceeds max ${MAX_PATTERN_LENGTH} (would take an extremely long time)`,
		);
	}
	for (let i = 0; i < pattern.length; i++) {
		if (!BASE58_CHARS.has(pattern[i])) {
			throw vanityError(
				'invalid_vanity',
				`${label}: invalid base58 char '${pattern[i]}' at position ${i + 1}`,
			);
		}
	}
}

function vanityError(code, msg) {
	return Object.assign(new Error(msg), { status: 400, code });
}

export function isValidVanityPrefix(prefix) {
	if (!prefix || typeof prefix !== 'string') return false;
	if (prefix.length > MAX_PATTERN_LENGTH) return false;
	for (const c of prefix) if (!BASE58_CHARS.has(c)) return false;
	return true;
}

/**
 * Does `address` satisfy the requested vanity pattern? The security boundary
 * for adopting a browser-ground keypair: the server must NEVER trust a client's
 * claim that a key is "vanity" — it re-derives the address and checks it here.
 * Case-insensitive matching is applied only when the owner explicitly asked for
 * it; otherwise an exact (case-sensitive) match is required.
 *
 * @param {string} address                      Base58 public key.
 * @param {{ prefix?: string, suffix?: string, ignoreCase?: boolean }} pattern
 * @returns {boolean}
 */
export function addressMatchesPattern(address, { prefix = '', suffix = '', ignoreCase = false } = {}) {
	if (typeof address !== 'string' || !address) return false;
	if (!prefix && !suffix) return false;
	const probe = ignoreCase ? address.toLowerCase() : address;
	const wantP = prefix ? (ignoreCase ? prefix.toLowerCase() : prefix) : '';
	const wantS = suffix ? (ignoreCase ? suffix.toLowerCase() : suffix) : '';
	if (wantP && !probe.startsWith(wantP)) return false;
	if (wantS && !probe.endsWith(wantS)) return false;
	return true;
}

// Estimated attempts ≈ 58^n (per pattern position). Used by callers to set
// a reasonable maxIterations and to surface difficulty in error messages.
export function estimateAttempts({ prefix, suffix, ignoreCase = false } = {}) {
	const len = (prefix?.length || 0) + (suffix?.length || 0);
	if (len === 0) return 1;
	const alphabetSize = ignoreCase ? 33 : 58; // lowercase-folded alphabet ≈ 33 distinct
	return Math.pow(alphabetSize, len);
}

/**
 * Grind a Solana Keypair whose base58 address matches a prefix and/or suffix.
 *
 * @param {object} opts
 * @param {string} [opts.prefix]      — required base58 prefix
 * @param {string} [opts.suffix]      — required base58 suffix
 * @param {boolean} [opts.ignoreCase] — case-insensitive match
 * @param {number} [opts.maxIterations] — hard cap (default 2M)
 * @param {number} [opts.maxMs] — wall-clock budget in ms (default Infinity). Bails
 *   with a `vanity_timeout` error before this elapses so a serverless invocation
 *   returns a clean 504 instead of being hard-killed by the platform's runtime limit.
 * @param {(sample:{iterations:number,elapsedMs:number,attemptsPerSec:number,sampleAddress:string})=>void} [opts.onProgress]
 *   — fired every PROGRESS_EVERY (25k) attempts with real, monotonic numbers. iterations
 *   and elapsedMs only ever increase; attemptsPerSec is the instantaneous windowed rate;
 *   sampleAddress is the actual candidate just generated (for on-screen texture).
 * @returns {Promise<{ keypair: Keypair, iterations: number, durationMs: number }>}
 */
export async function grindMintKeypair({
	prefix,
	suffix,
	ignoreCase = false,
	maxIterations = DEFAULT_MAX_ITERATIONS,
	maxMs = Infinity,
	onProgress,
	progressEvery = PROGRESS_EVERY,
} = {}) {
	if (!prefix && !suffix) {
		const kp = Keypair.generate();
		return { keypair: kp, iterations: 1, durationMs: 0 };
	}
	if (prefix) validatePattern(prefix, 'prefix');
	if (suffix) validatePattern(suffix, 'suffix');
	const sampleEvery = Math.max(1, Math.floor(progressEvery) || PROGRESS_EVERY);

	const targetPrefix = prefix ? (ignoreCase ? prefix.toLowerCase() : prefix) : null;
	const targetSuffix = suffix ? (ignoreCase ? suffix.toLowerCase() : suffix) : null;
	const pLen = targetPrefix?.length || 0;
	const sLen = targetSuffix?.length || 0;

	const start = Date.now();
	const deadline = Number.isFinite(maxMs) ? start + maxMs : Infinity;
	let lastProgressAt = start;
	let lastProgressAttempts = 0;

	const timeout = (attempts) =>
		Object.assign(
			new Error(
				`vanity ${prefix ? `prefix '${prefix}'` : ''}${prefix && suffix ? ' + ' : ''}${suffix ? `suffix '${suffix}'` : ''} not found in ${attempts.toLocaleString()} attempts (estimated ~${Math.round(estimateAttempts({ prefix, suffix, ignoreCase })).toLocaleString()})`,
			),
			{ status: 504, code: 'vanity_timeout' },
		);

	for (let i = 1; i <= maxIterations; i++) {
		// Cheap, frequent deadline check so a wall-clock budget bails promptly.
		if (deadline !== Infinity && i % TIME_CHECK_EVERY === 0 && Date.now() >= deadline) {
			throw timeout(i);
		}

		const kp = Keypair.generate();
		const addr = kp.publicKey.toBase58();

		// Emit a live progress sample from real numbers. attemptsPerSec is the
		// instantaneous rate over the window since the previous sample, never a
		// synthetic counter. sampleAddress is the actual candidate just generated,
		// surfaced purely for on-screen texture (the "almost right" flicker).
		if (onProgress && i % sampleEvery === 0) {
			const now = Date.now();
			const windowMs = now - lastProgressAt;
			const windowAttempts = i - lastProgressAttempts;
			const attemptsPerSec = windowMs > 0 ? (windowAttempts / windowMs) * 1000 : 0;
			lastProgressAt = now;
			lastProgressAttempts = i;
			try {
				onProgress({ iterations: i, elapsedMs: now - start, attemptsPerSec, sampleAddress: addr });
			} catch {
				// A misbehaving progress sink must never abort a paid grind.
			}
		}

		const head = ignoreCase ? addr.substring(0, pLen).toLowerCase() : addr.substring(0, pLen);
		if (targetPrefix && head !== targetPrefix) {
			if (i % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
			continue;
		}
		const tail = ignoreCase ? addr.substring(addr.length - sLen).toLowerCase() : addr.substring(addr.length - sLen);
		if (targetSuffix && tail !== targetSuffix) {
			if (i % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
			continue;
		}

		return { keypair: kp, iterations: i, durationMs: Date.now() - start };
	}

	throw timeout(maxIterations);
}

// Pure transform for the live Vanity Address Miner (feature #11).
//
// Turns the real grind numbers (iterations, elapsedMs) emitted by
// grindMintKeypair's onProgress callback into the stats the agent-screen frame
// renders: instantaneous attempts/sec, the statistically-expected attempt count
// for the requested pattern, and a probability-of-completion progress value.
//
// Every value derives from real iteration counts — there is no synthetic
// counter anywhere. `progress` is explicitly a probability indicator (clamped to
// 1), never a guaranteed completion bar: a grind can land before or well after
// its expected attempt count.

import { estimateAttempts } from './pump-vanity.js';

/**
 * @param {object} p
 * @param {number} p.iterations        — current real attempt count
 * @param {number} p.elapsedMs         — ms since the grind started
 * @param {number} [p.prevIterations]  — attempt count at the previous sample
 * @param {number} [p.prevElapsedMs]   — elapsedMs at the previous sample
 * @param {string} [p.prefix]
 * @param {string} [p.suffix]
 * @param {boolean} [p.ignoreCase]
 * @returns {{ attemptsPerSec:number, expectedIterations:number, progress:number, etaSec:number|null }}
 */
export function computeGrindStats({
	iterations,
	elapsedMs,
	prevIterations = 0,
	prevElapsedMs = 0,
	prefix = '',
	suffix = '',
	ignoreCase = false,
} = {}) {
	const iters = Math.max(0, Number(iterations) || 0);
	const elapsed = Math.max(0, Number(elapsedMs) || 0);

	// Instantaneous rate over the window since the previous sample. Falls back to
	// the cumulative average when there is no prior sample (or a zero window), so
	// the first frame still shows a real number instead of 0.
	const windowIters = iters - (Number(prevIterations) || 0);
	const windowMs = elapsed - (Number(prevElapsedMs) || 0);
	let attemptsPerSec;
	if (windowMs > 0 && windowIters > 0) {
		attemptsPerSec = (windowIters / windowMs) * 1000;
	} else if (elapsed > 0) {
		attemptsPerSec = (iters / elapsed) * 1000;
	} else {
		attemptsPerSec = 0;
	}

	const expectedIterations = Math.round(estimateAttempts({ prefix, suffix, ignoreCase }));
	const progress = expectedIterations > 0 ? Math.min(1, iters / expectedIterations) : 0;

	// ETA to the statistical expectation, in seconds, from the live rate. Null
	// once we're already past expectation (the search is "overdue" — still real,
	// just unlucky) or before we have a rate.
	let etaSec = null;
	if (attemptsPerSec > 0 && iters < expectedIterations) {
		etaSec = (expectedIterations - iters) / attemptsPerSec;
	}

	return { attemptsPerSec, expectedIterations, progress, etaSec };
}

/**
 * Compact one-line activity string for the screen log + the agents-live card
 * ticker, e.g. "4.18M attempts · 38.9k/sec · expected ~11.3M". Pure formatting.
 */
export function formatGrindActivity({ iterations, attemptsPerSec, expectedIterations }) {
	return `${abbrev(iterations)} attempts · ${abbrev(attemptsPerSec)}/sec · expected ~${abbrev(expectedIterations)}`;
}

// 4_182_330 → "4.18M", 38_900 → "38.9k", 420 → "420".
export function abbrev(n) {
	const v = Math.max(0, Number(n) || 0);
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
	return String(Math.round(v));
}

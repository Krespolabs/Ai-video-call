/**
 * Text-timed lip-sync envelope — the fallback lane for when there's no audio to
 * analyse (no Web Audio, muted reply, JSDOM). It reads the words themselves:
 * vowels open the mouth, bilabials (b/m/p) clamp it shut, the timeline length
 * tracks the word count at a speaking rate. Output is a coarse three-channel
 * mouth shape — open (jaw), wide (smile-stretch), round (funnel/pucker) — that
 * the renderer maps onto whatever visemes the rig exposes.
 *
 * Deterministic by construction: the same text + rate always produces the same
 * motion, so two viewers of the same turn lip-sync identically. The only state
 * is a gentle ease toward rest once the line is over, so sampling past the end
 * settles the mouth closed instead of holding the last frame open.
 */

const MIN_DURATION = 0.6;
const MAX_DURATION = 40;
const DEFAULT_WPM = 165;
// Per-frame ease toward the target shape. Fast enough to track syllables, slow
// enough to read as a mouth rather than a strobe.
const EASE = 0.45;

function clamp01(n) {
	if (Number.isNaN(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n));
}

function wordCount(text) {
	const trimmed = typeof text === 'string' ? text.trim() : '';
	if (!trimmed) return 0;
	return trimmed.split(/\s+/).length;
}

/**
 * Estimate how long a line of text takes to speak, in seconds, clamped to a
 * sane range. Grows with word count at the given words-per-minute rate.
 *
 * @param {string} text
 * @param {number} [wpm=165]
 * @returns {number}
 */
export function estimateSpeechDuration(text, wpm = DEFAULT_WPM) {
	const words = wordCount(text);
	const rate = Number.isFinite(wpm) && wpm > 0 ? wpm : DEFAULT_WPM;
	// Even an empty/one-word line takes a beat; longer lines scale linearly.
	const seconds = (words / rate) * 60;
	return clamp(seconds, MIN_DURATION, MAX_DURATION);
}

// Phoneme buckets keyed off the spelling. Each character contributes a target
// shape; the envelope walks them across the timeline.
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const ROUND_VOWELS = new Set(['o', 'u']);
const WIDE_VOWELS = new Set(['e', 'i']);
const BILABIAL = new Set(['b', 'm', 'p']);

// Per-character mouth target. Vowels open; e/i pull wide, o/u round; bilabials
// snap shut; other consonants crack the mouth slightly so speech doesn't read
// as a string of closed pauses.
function shapeForChar(ch) {
	if (VOWELS.has(ch)) {
		return {
			open: ROUND_VOWELS.has(ch) ? 0.6 : 0.95,
			wide: WIDE_VOWELS.has(ch) ? 0.7 : 0.1,
			round: ROUND_VOWELS.has(ch) ? 0.8 : 0.05,
		};
	}
	if (BILABIAL.has(ch)) {
		return { open: 0, wide: 0, round: 0.1 };
	}
	// Any other letter — a partial open with a touch of stretch.
	return { open: 0.3, wide: 0.25, round: 0.05 };
}

/**
 * A deterministic, text-driven mouth envelope.
 */
export class TextVisemeEnvelope {
	/**
	 * @param {string} text
	 * @param {{ wpm?: number }} [options]
	 */
	constructor(text, options = {}) {
		const wpm = options && Number.isFinite(options.wpm) && options.wpm > 0 ? options.wpm : DEFAULT_WPM;
		this.duration = estimateSpeechDuration(text, wpm);

		// Reduce the text to its mouth-bearing letters, in order. Spaces and
		// punctuation drop out — they're silences the timeline glides over.
		this._chars = (typeof text === 'string' ? text : '')
			.toLowerCase()
			.replace(/[^a-z]/g, '')
			.split('');

		// Eased state, advanced on every sample so a past-the-end sample settles
		// the mouth shut over successive frames.
		this._cur = { open: 0, wide: 0, round: 0 };
	}

	// The target shape at time t, before easing. Past the end, target is rest.
	_targetAt(t) {
		if (this._chars.length === 0 || t < 0 || t >= this.duration) {
			return { open: 0, wide: 0, round: 0 };
		}
		const idx = Math.min(this._chars.length - 1, Math.floor((t / this.duration) * this._chars.length));
		return shapeForChar(this._chars[idx]);
	}

	/**
	 * Sample the mouth shape at time t (seconds). Eases the internal state toward
	 * the target for t, so repeated samples animate smoothly and a sample past
	 * the end relaxes the mouth closed.
	 *
	 * @param {number} t
	 * @returns {{ open: number, wide: number, round: number }}
	 */
	sample(t) {
		const target = this._targetAt(t);
		this._cur.open = clamp01(this._cur.open + (target.open - this._cur.open) * EASE);
		this._cur.wide = clamp01(this._cur.wide + (target.wide - this._cur.wide) * EASE);
		this._cur.round = clamp01(this._cur.round + (target.round - this._cur.round) * EASE);
		return { open: this._cur.open, wide: this._cur.wide, round: this._cur.round };
	}

	/**
	 * Has the spoken line finished by time t?
	 *
	 * @param {number} t
	 * @returns {boolean}
	 */
	done(t) {
		return t >= this.duration;
	}
}

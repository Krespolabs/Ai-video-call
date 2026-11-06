// The Sentiment Scout's read: one or two plain sentences per candidate,
// written by the platform LLM chain FROM the evidence lines and nothing else.
//
// The evidence is built deterministically (api/_lib/sentiment-scout.js); this
// layer only turns it into something a first-time reader can take in at a
// glance. Because a model will happily invent a follower count or a "10x", no
// note is trusted as written. validateScoutNote() rejects any note that:
//   - contains a number that does not appear in that candidate's evidence,
//     caution or score (so it cannot add a fact),
//   - names a ticker other than the candidate's own or $THREE,
//   - carries a link, or
//   - makes a promise or a call to action ("guaranteed", "can't lose", "buy now").
// A rejected note is dropped, never repaired: the candidate simply shows its
// evidence without a summary. The completion function is injectable so the
// tests drive the real prompt building, parsing and validation.

import { llmComplete } from './llm.js';

export const MAX_NOTE_CHARS = 260;
const NOTE_TIMEOUT_MS = 20_000;
const NOTE_CACHE_TTL_MS = 10 * 60_000;

const PROMISE_RE = /\b(guarantee[ds]?|guaranteed|risk[- ]free|can'?t lose|cannot lose|sure thing|free money|to the moon|will (?:moon|pump|10x|100x|explode)|buy now|ape in|load up|send it|don'?t miss|not financial advice|nfa)\b/i;
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|io|fun|xyz|net|org|ws|app|gg)\b)/i;
// Venue names that appear in the evidence itself are words here, not links.
const VENUE_NAMES_RE = /\b(?:pump\.fun|three\.ws)\b/gi;
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{1,15})\b/g;
const NUMBER_RE = /\d+(?:[.,]\d+)?/g;

export const SCOUT_NOTE_SYSTEM = `You write the Sentiment Scout's read for pump.fun token candidates. You do NOT trade and you do NOT advise trading.

For each candidate you are given its ticker, a momentum score, evidence lines, and a caution line. Write TWO short plain-English sentences, under ${MAX_NOTE_CHARS - 40} characters in total: the first says what the strongest evidence shows, the second names the main risk in your own words (do not paste the caution line).

Hard rules:
- Use ONLY facts in that candidate's evidence and caution. Every number you write must appear there exactly. Never add a follower count, a price, a multiple, or a percentage that is not given.
- If the evidence is thin or comes from one voice, say so plainly. Do not pad it.
- Mention no token other than the candidate's own ticker or $THREE.
- No links, no emojis, no hype, no promises, no instructions to buy or sell.

Reply with STRICT JSON and nothing else:
{"notes":[{"mint":"<mint>","note":"<one or two sentences>"}]}`;

/** The user prompt for a batch of candidates. Pure. */
export function buildScoutNotePrompt(candidates) {
	const blocks = candidates.map((c) => [
		`mint: ${c.mint}`,
		`ticker: ${c.ticker || '(none)'}`,
		`momentum_score: ${c.momentum_score}/100`,
		'evidence:',
		...c.evidence.map((e) => `- ${e.type}: ${e.detail}`),
		`caution: ${c.caution}`,
	].join('\n'));
	return `Write the Scout's read for each candidate below.\n\n${blocks.join('\n\n')}`;
}

/** Pull the notes array out of a model reply. Tolerates fences and prose. Pure. */
export function parseScoutNotes(text) {
	if (!text) return [];
	const match = String(text).match(/\{[\s\S]*\}/);
	if (!match) return [];
	let obj;
	try {
		obj = JSON.parse(match[0]);
	} catch {
		return [];
	}
	const list = Array.isArray(obj?.notes) ? obj.notes : [];
	return list
		.filter((n) => n && typeof n.mint === 'string' && typeof n.note === 'string')
		.map((n) => ({ mint: n.mint.trim(), note: n.note.replace(/\s+/g, ' ').trim() }));
}

// Counts spelled out as words are facts too ("five other coins"). "one" is
// left out: it is used idiomatically ("one voice", "one account") far more
// often than as a count a reader would check.
const WORD_NUMBERS = {
	two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
	eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
	seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, dozen: 12, hundred: 100,
};
const WORD_NUMBER_RE = new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join('|')})\\b`, 'gi');

function numbersIn(text) {
	return (String(text).match(NUMBER_RE) || []).map((n) => n.replace(',', '.'));
}

// Word counts in prose, as digit strings. "$THREE" is a ticker, not a count.
function wordNumbersIn(text) {
	const prose = String(text).replace(TICKER_RE, '');
	return [...prose.matchAll(WORD_NUMBER_RE)].map((m) => String(WORD_NUMBERS[m[1].toLowerCase()]));
}

/**
 * Check one note against the candidate it describes. Pure.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateScoutNote(note, candidate) {
	const text = String(note || '').trim();
	if (text.length < 20) return { ok: false, reason: 'too_short' };
	if (text.length > MAX_NOTE_CHARS) return { ok: false, reason: 'too_long' };
	if (URL_RE.test(text.replace(VENUE_NAMES_RE, ''))) return { ok: false, reason: 'link' };
	if (PROMISE_RE.test(text)) return { ok: false, reason: 'promise' };

	const own = String(candidate.ticker || '').replace(/^\$/, '').toLowerCase();
	for (const m of text.matchAll(TICKER_RE)) {
		const t = m[1].toLowerCase();
		if (t !== own && t !== 'three') return { ok: false, reason: 'foreign_ticker' };
	}

	const grounded = new Set([
		...numbersIn(candidate.caution || ''),
		...candidate.evidence.flatMap((e) => numbersIn(e.detail)),
		String(candidate.momentum_score),
		'100', // "out of 100" when restating the score
	]);
	// The ticker itself may contain digits ($ABC2); those are not facts.
	const tickerDigits = new Set(numbersIn(own));
	for (const n of [...numbersIn(text), ...wordNumbersIn(text)]) {
		if (grounded.has(n) || tickerDigits.has(n)) continue;
		return { ok: false, reason: `ungrounded_number:${n}` };
	}
	return { ok: true };
}

/** A stable key for "the evidence this note was written from". Pure. */
export function noteSignature(candidate) {
	return [
		candidate.mint,
		Math.round(candidate.momentum_score / 5),
		candidate.caution,
		...candidate.evidence.map((e) => `${e.type}:${e.detail}`),
	].join('|');
}

const _notes = new Map(); // signature -> { value, at }

/**
 * Write validated notes for a batch of candidates in ONE completion. Returns
 * a Map of mint -> { note, model, provider }. A candidate whose note failed
 * validation, or a batch whose completion failed, is simply absent: the
 * caller shows evidence without a summary.
 *
 * @param {Array<object>} candidates  shaped Scout candidates
 * @param {{ complete?: Function, timeoutMs?: number }} [opts]
 */
export async function writeScoutNotes(candidates, { complete = llmComplete, timeoutMs = NOTE_TIMEOUT_MS } = {}) {
	const out = new Map();
	const now = Date.now();
	const todo = [];
	for (const c of candidates || []) {
		if (!c?.evidence?.length) continue;
		const hit = _notes.get(noteSignature(c));
		if (hit && now - hit.at < NOTE_CACHE_TTL_MS) {
			if (hit.value) out.set(c.mint, hit.value);
		} else {
			todo.push(c);
		}
	}
	if (!todo.length) return out;

	let res;
	try {
		res = await complete({
			system: SCOUT_NOTE_SYSTEM,
			user: buildScoutNotePrompt(todo),
			maxTokens: 120 * todo.length + 80,
			timeoutMs,
			track: { tool: 'sentiment_scout_notes' },
		});
	} catch {
		return out;
	}
	const byMint = new Map(parseScoutNotes(res?.text).map((n) => [n.mint, n.note]));
	for (const c of todo) {
		const note = byMint.get(c.mint);
		const verdict = note ? validateScoutNote(note, c) : { ok: false };
		const value = verdict.ok ? { note, model: res?.model || null, provider: res?.provider || null } : null;
		_notes.set(noteSignature(c), { value, at: now });
		if (value) out.set(c.mint, value);
	}
	if (_notes.size > 500) {
		for (const [k, v] of _notes) if (now - v.at > NOTE_CACHE_TTL_MS) _notes.delete(k);
	}
	return out;
}

/** Test seam. */
export function _resetScoutNotes() {
	_notes.clear();
}

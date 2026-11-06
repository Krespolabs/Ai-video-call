// Parse a natural-language vanity-grind command typed into the agent-screen task
// bar, e.g. "grind a wallet starting with pump", "grind pump", "vanity ending
// with 42", "branded wallet prefix nova suffix xyz". Returns a normalised
// { prefix, suffix, ignoreCase } request, or null when the text isn't a grind
// command (so the task bar falls through to the normal task queue).
//
// Pure string logic — no network, no key material. The server
// (/api/agent-vanity-grind) is the real validator and the only place a keypair
// is ever generated; this just extracts intent.

// Solana base58 alphabet (no 0 O I l). A captured token must be entirely base58
// to be a usable prefix/suffix; anything else is treated as "no token found".
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const MAX_LEN = 6;

const TRIGGER = /\b(grind|vanity)\b|\bbranded\s+wallet\b|\bvanity\s+address\b/i;

// Phrase → which side of the address it targets.
const PREFIX_PHRASES = /(?:starts?\s+with|starting\s+with|begins?\s+with|beginning\s+with|prefix(?:ed\s+with)?)\s+["'`]?([1-9A-HJ-NP-Za-km-z]{1,12})/i;
const SUFFIX_PHRASES = /(?:ends?\s+with|ending\s+with|suffix(?:ed\s+with)?)\s+["'`]?([1-9A-HJ-NP-Za-km-z]{1,12})/i;
// Bare form: "grind pump" / "vanity pump" — the word right after the trigger.
const BARE = /\b(?:grind|vanity)\b\s+(?:a\s+)?(?:wallet\s+|address\s+)?["'`]?([1-9A-HJ-NP-Za-km-z]{1,12})/i;

function clean(tok) {
	if (!tok) return '';
	const t = String(tok).trim();
	if (!BASE58.test(t)) return '';
	return t.slice(0, MAX_LEN);
}

/**
 * @param {string} input
 * @returns {{ prefix: string, suffix: string|null, ignoreCase: boolean, raw: string } | null}
 */
export function parseGrindCommand(input) {
	const text = String(input || '').trim();
	if (!text || !TRIGGER.test(text)) return null;

	let prefix = '';
	let suffix = '';

	const pm = text.match(PREFIX_PHRASES);
	if (pm) prefix = clean(pm[1]);
	const sm = text.match(SUFFIX_PHRASES);
	if (sm) suffix = clean(sm[1]);

	// Fall back to the bare "grind <token>" form only when no explicit
	// prefix/suffix phrase matched — and skip filler words that aren't a pattern.
	if (!prefix && !suffix) {
		const bm = text.match(BARE);
		const cand = bm ? clean(bm[1]) : '';
		const FILLER = new Set(['a', 'an', 'the', 'me', 'wallet', 'address', 'vanity', 'with', 'for', 'my']);
		if (cand && !FILLER.has(cand.toLowerCase())) prefix = cand;
	}

	if (!prefix && !suffix) return null;

	// Case-sensitive only when the user explicitly asks; the default keeps grinds
	// feasible (case-insensitive ≈ halves the difficulty per char).
	const ignoreCase = !/\b(case[-\s]?sensitive|exact\s+case|match\s+case)\b/i.test(text);

	return { prefix, suffix: suffix || null, ignoreCase, raw: text };
}

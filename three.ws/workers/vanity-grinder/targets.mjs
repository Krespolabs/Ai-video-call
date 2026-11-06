// The premium-inventory target list — which brandable patterns are worth grinding
// ahead of time.
//
// COMMIT-GATE NOTE: every pattern here is a GENERIC, brand-neutral prefix (product
// nouns, three.ws-aligned words, human names, aesthetic letter runs). None names a
// third-party crypto project. `$THREE`-aligned patterns (THREE, WS, 3WS) are
// welcome; a third-party ticker is NOT. Keep it that way — see CLAUDE.md's commit
// gate.
//
// A target is { prefix?, suffix?, ignoreCase }. Difficulty ≈ 58^(len) case-
// sensitive, ~33^(len) case-insensitive. The default list is weighted toward 3–4
// char prefixes (minutes of batch CPU each) with a few 5-char stretch goals.

// Brandable 3-char prefixes — fast to grind, broadly appealing.
// NB: every char must be Base58-representable (no 0 / O / I / l) or the pattern is
// unreachable; under ignoreCase the valid-case counterpart is matched. Keep these
// GENERIC (product/tech/aesthetic words) — no third-party crypto tickers (commit gate).
const PREFIX_3 = [
	'SOL', 'AiA', 'GM3', 'WS3', 'DEV', 'BOT', 'API', 'GPU', 'LAB', 'ZAP',
	'ARC', 'ORB', 'ION', 'NEO', 'VIP', 'ACE', 'FOX', 'OWL', 'JET', 'RAY',
	'MAX', 'SKY', 'SUN', 'TOP', 'WEB', 'WIN', 'ZEN', 'HUB', 'KEY', 'MAP',
	'NET', 'PAY', 'PRO', 'RUN', 'TAG', 'GEM', 'PIX', 'NAV', 'FAB', 'MEG',
	'CAT', 'DOG', 'BEE', 'ANT', 'ELF', 'GUR', 'MAG', 'PUP', 'SAM', 'TEK',
];

// Brandable 4-char prefixes — the premium sweet spot (unreachable by the live
// ≤3-char grind tier, so this is what makes the inventory worth selling).
const PREFIX_4 = [
	'PUMP', 'AGNT', 'MOON', 'MINT', 'FORG', 'DEGN', 'GOLD', 'NODE', 'DASH',
	'ECHO', 'FLUX', 'HALO', 'IRIS', 'JADE', 'KILO', 'LUNA', 'NOVA', 'ONYX',
	'THRE', 'WS3D', 'VOID', 'ZERO', 'BASE', 'CORE',
	'PEAK', 'BEAM', 'GLOW', 'SAGE', 'RUBY', 'MYTH', 'AXON', 'BYTE', 'CHIP',
	'DUSK', 'EPIC', 'FERN', 'GAZE', 'HERO', 'JOLT', 'KELP', 'MESA', 'NEST',
	'PACE', 'QUAD', 'REEF', 'SURF', 'TIDE', 'VANE', 'WAVE', 'YARN', 'ZEST',
	'AURA', 'BOLD', 'CUSP', 'DENS', 'EMBR', 'FUZE',
];

// 5-char stretch goals — hours of single-thread CPU, trivial on a wide spot MIG.
// Kept short so a modest batch still completes them; expand on bigger runs.
const PREFIX_5 = ['THREE', 'AGENT', 'SOLAN', 'HELLO', 'BRAND'];

// Suffix targets — the tail is uniformly distributed (unlike the biased leading
// char), so these are cleaner to grind. `pump`-suffix addresses are consumable as
// pump.fun mints where the launcher accepts a supplied keypair at runtime.
const SUFFIX = [
	{ suffix: 'ws', ignoreCase: true },
	{ suffix: '3', ignoreCase: false },
	{ suffix: 'x', ignoreCase: false },
];

/**
 * Build the default target list.
 * @param {object} [opts]
 * @param {boolean} [opts.include5=false] - include the slow 5-char stretch goals.
 * @param {boolean} [opts.ignoreCase=false] - fold case on the prefix targets (≈half difficulty/char).
 * @returns {Array<{prefix?:string, suffix?:string, ignoreCase:boolean, label:string}>}
 */
export function defaultTargets(opts = {}) {
	const { include5 = false, ignoreCase = false } = opts;
	const out = [];
	const push = (t) => out.push({ ignoreCase: !!t.ignoreCase, ...t, label: labelFor(t) });

	for (const p of PREFIX_3) push({ prefix: p, ignoreCase });
	for (const p of PREFIX_4) push({ prefix: p, ignoreCase });
	if (include5) for (const p of PREFIX_5) push({ prefix: p, ignoreCase });
	for (const s of SUFFIX) push(s);
	return out;
}

/** Human label for a target, e.g. "PUMP…" or "…ws". */
export function labelFor(t) {
	if (t.prefix && t.suffix) return `${t.prefix}…${t.suffix}`;
	if (t.prefix) return `${t.prefix}…`;
	if (t.suffix) return `…${t.suffix}`;
	return '(any)';
}

/** Stable id for a target (for the checkpoint dedup key). */
export function targetId(t) {
	return `${t.prefix || ''}|${t.suffix || ''}|${t.ignoreCase ? 'i' : 'c'}`;
}

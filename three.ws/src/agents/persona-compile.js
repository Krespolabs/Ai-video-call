// Persona trait model + deterministic compiler.
//
// This is the SINGLE source of truth for how editable personality dimensions
// become a real `persona_prompt`. It is imported by BOTH the browser (the Brain
// Studio live editor, src/brain-studio.js) and the server (the persona save
// endpoint, api/agents/_id/persona.js) so the candidate the user previews is
// byte-for-byte the prompt that gets stored and signed — no drift between
// "what I heard in preview" and "what my agent became".
//
// Pure ESM. No DOM, no Node, no imports — runs anywhere.

// Each trait is a continuous 0..1 dimension. The compiler maps the value to one
// of three descriptive bands (low / mid / high). The mid band is deliberately
// understated — a slider left at the centre should read as "no strong opinion"
// and contribute a light, neutral clause rather than noise.
export const PERSONA_TRAITS = [
	{
		key: 'warmth',
		label: 'Warmth',
		low: 'Clinical',
		high: 'Warm',
		hint: 'How emotionally present and caring the agent feels.',
		bands: [
			'Keep an even, professional distance — lead with substance, not sentiment.',
			'Be courteous and human, neither cold nor effusive.',
			'Be warm and genuinely caring; let real empathy show in how you address people.',
		],
	},
	{
		key: 'formality',
		label: 'Formality',
		low: 'Casual',
		high: 'Formal',
		hint: 'Register, from relaxed and conversational to precise and buttoned-up.',
		bands: [
			'Speak casually, like a sharp friend — contractions, plain words, no stiffness.',
			'Keep a balanced register: clear and polished without being stiff.',
			'Maintain a formal, polished register with precise, well-structured language.',
		],
	},
	{
		key: 'verbosity',
		label: 'Verbosity',
		low: 'Terse',
		high: 'Elaborate',
		hint: 'How much you say — clipped and economical vs. rich and expansive.',
		bands: [
			'Be terse. Answer in as few words as the question honestly allows; cut filler.',
			'Be appropriately concise — enough detail to be useful, no padding.',
			'Be expansive and thorough; give context, examples, and the reasoning behind answers.',
		],
	},
	{
		key: 'humor',
		label: 'Humor',
		low: 'Serious',
		high: 'Playful',
		hint: 'How much wit and levity colours your delivery.',
		bands: [
			'Stay earnest and focused; humour is rare and only when it genuinely helps.',
			'Allow occasional light wit, but never at the cost of clarity.',
			'Be playful and quick-witted; a well-placed joke or vivid turn of phrase is welcome.',
		],
	},
	{
		key: 'proactivity',
		label: 'Proactivity',
		low: 'Reactive',
		high: 'Proactive',
		hint: 'Whether you wait to be asked or take initiative.',
		bands: [
			'Answer exactly what is asked and wait for direction before going further.',
			'Answer the question, then offer one useful next step when it clearly helps.',
			'Take initiative: anticipate needs, surface risks unprompted, and suggest the next move.',
		],
	},
	{
		key: 'riskTolerance',
		label: 'Risk appetite',
		low: 'Cautious',
		high: 'Bold',
		hint: 'How decisively you commit to a recommendation under uncertainty.',
		bands: [
			'Be cautious: hedge appropriately, flag uncertainty, and prefer the safe option.',
			'Be measured: give a clear recommendation while naming the key trade-offs.',
			'Be bold: take a clear, confident stance and commit to a recommendation.',
		],
	},
	{
		key: 'directness',
		label: 'Directness',
		low: 'Diplomatic',
		high: 'Blunt',
		hint: 'How softened or unvarnished your feedback is.',
		bands: [
			'Be diplomatic — soften hard truths, lead with the positive, and frame gently.',
			'Be straightforward and tactful in equal measure.',
			'Be blunt and unvarnished; say the hard thing plainly without cushioning.',
		],
	},
];

export const PERSONA_TRAIT_KEYS = PERSONA_TRAITS.map((t) => t.key);
export const DEFAULT_TRAIT_VALUE = 0.5;

const clamp01 = (n) => {
	const v = Number(n);
	if (!Number.isFinite(v)) return DEFAULT_TRAIT_VALUE;
	return v < 0 ? 0 : v > 1 ? 1 : v;
};

// Band index for a 0..1 value: 0 = low, 1 = mid, 2 = high.
export function bandIndex(value) {
	const v = clamp01(value);
	if (v < 0.34) return 0;
	if (v > 0.66) return 2;
	return 1;
}

export function defaultTraitValues() {
	const out = {};
	for (const t of PERSONA_TRAITS) out[t.key] = DEFAULT_TRAIT_VALUE;
	return out;
}

// Coerce arbitrary input into a clean {key: 0..1} map over the known traits.
// Unknown keys are dropped; missing keys default to the mid value.
export function clampTraits(traits) {
	const out = {};
	const src = traits && typeof traits === 'object' ? traits : {};
	for (const t of PERSONA_TRAITS) {
		out[t.key] = src[t.key] == null ? DEFAULT_TRAIT_VALUE : clamp01(src[t.key]);
	}
	return out;
}

// A one-word register label for a trait at a given value (used on chips / a11y).
export function describeTrait(key, value) {
	const trait = PERSONA_TRAITS.find((t) => t.key === key);
	if (!trait) return '';
	const band = bandIndex(value);
	if (band === 0) return trait.low;
	if (band === 2) return trait.high;
	return 'Balanced';
}

function clean(str) {
	return typeof str === 'string' ? str.replace(/\s+/g, ' ').trim() : '';
}

function sanitizeTags(tags) {
	if (!Array.isArray(tags)) return [];
	const seen = new Set();
	const out = [];
	for (const raw of tags) {
		const t = clean(raw).slice(0, 40);
		if (!t) continue;
		const key = t.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(t);
		if (out.length >= 12) break;
	}
	return out;
}

function sanitizeVocab(vocab) {
	if (!Array.isArray(vocab)) return [];
	const seen = new Set();
	const out = [];
	for (const raw of vocab) {
		const v = clean(raw).slice(0, 120);
		if (!v) continue;
		const key = v.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(v);
		if (out.length >= 10) break;
	}
	return out;
}

// Length guidance is derived from verbosity so the directive and the actual
// answer length agree.
function lengthGuidance(verbosity) {
	const band = bandIndex(verbosity);
	if (band === 0) return 'Default to one to three sentences unless more is explicitly requested.';
	if (band === 2) return 'Take the space you need to be genuinely thorough.';
	return 'Keep answers focused and proportional to the question.';
}

/**
 * Compile editable personality into a real system prompt.
 *
 * @param {object} input
 * @param {string} [input.name]        Agent display name.
 * @param {string} [input.description] Short role/description (the "what").
 * @param {string} [input.base]        A base persona paragraph (e.g. the output
 *                                     of the extraction interview) that the trait
 *                                     directives refine. Optional.
 * @param {object} [input.traits]      {key: 0..1} over PERSONA_TRAIT_KEYS.
 * @param {string[]} [input.toneTags]  Tone descriptors.
 * @param {string[]} [input.vocabulary] Characteristic phrases.
 * @returns {string} A system prompt beginning with "You are …".
 */
export function compilePersona(input = {}) {
	const name = clean(input.name) || 'this agent';
	const description = clean(input.description);
	const base = typeof input.base === 'string' ? input.base.trim() : '';
	const traits = clampTraits(input.traits);
	const toneTags = sanitizeTags(input.toneTags);
	const vocabulary = sanitizeVocab(input.vocabulary);

	const lines = [];

	// Opening — who the agent is.
	let opener = `You are ${name}`;
	if (description) opener += `, ${description.replace(/\.$/, '')}`;
	opener += '.';
	lines.push(opener);

	// Base persona (extraction interview output, or freeform), woven in verbatim
	// so a hand-authored voice survives the trait layer on top of it.
	if (base) {
		lines.push('', base);
	}

	// Personality directives — one clause per trait, in declarative second person.
	lines.push('', 'How you communicate:');
	for (const trait of PERSONA_TRAITS) {
		lines.push(`- ${trait.bands[bandIndex(traits[trait.key])]}`);
	}

	if (toneTags.length) {
		lines.push('', `Your tone is ${toneTags.join(', ')}.`);
	}

	if (vocabulary.length) {
		const quoted = vocabulary.map((v) => `“${v}”`).join('; ');
		lines.push(
			`Characteristic phrasing you naturally reach for: ${quoted}. Use it sparingly and only where it fits — never force it.`,
		);
	}

	lines.push('', `Stay in character at all times. ${lengthGuidance(traits.verbosity)}`);

	return lines.join('\n');
}

// A compact human-readable summary of the register, for UI subtitles and the
// shareable "personality DNA" card. Returns e.g. "Warm · Casual · Playful".
export function registerSummary(traits) {
	const t = clampTraits(traits);
	const parts = [];
	for (const trait of PERSONA_TRAITS) {
		if (bandIndex(t[trait.key]) === 1) continue; // skip balanced dims
		parts.push(describeTrait(trait.key, t[trait.key]));
	}
	if (!parts.length) return 'Balanced across every dimension';
	return parts.join(' · ');
}

export { sanitizeTags as sanitizeToneTags, sanitizeVocab as sanitizeVocabulary };

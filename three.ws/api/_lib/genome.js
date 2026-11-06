// Agent Genome — deterministic, seed-recorded, verifiable trait inheritance.
//
// This module is the provable heart of agent breeding. Given two parent genomes
// and a recorded seed it derives a child genome that is a bounded recombination
// of both parents — brain disposition, voice parameters, body/visual traits, and
// skill alleles — with every random choice drawn from the seed. The same
// (parentA, parentB, seed) ALWAYS produces a byte-identical child genome, so a
// breeding event is re-derivable and a forged "child" is detectable
// (`verifyGenome`). No randomness ever enters without flowing through the seed.
//
// Pure functions only — no DB, no network, no `Date.now()`. The breeding endpoint
// (api/genome/breed.js) wraps this with wallet provisioning, artifact synthesis
// (real TTS voice settings, baked GLB, persona prompt), on-chain skill grants, and
// lineage persistence. Keeping the genetics pure makes the invariants testable and
// the pedigree auditable.

import { createHash } from 'node:crypto';

export const GENOME_VERSION = 1;

// ── Deterministic PRNG ───────────────────────────────────────────────────────
// xmur3 string hash → mulberry32 stream. Each genetic locus draws from its OWN
// stream keyed by `${seed}::${locus}`, so loci are independent and order-free:
// adding a new locus never perturbs the draws of existing ones, which keeps old
// genomes verifiable as the schema grows.

function xmur3(str) {
	let h = 1779033703 ^ str.length;
	for (let i = 0; i < str.length; i++) {
		h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	return () => {
		h = Math.imul(h ^ (h >>> 16), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		return (h ^= h >>> 16) >>> 0;
	};
}

function mulberry32(a) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// A reproducible draw in [0,1) for a (seed, locus) pair. Pull `n` to get the
// nth independent draw on the same locus stream.
export function draw(seed, locus, n = 0) {
	const seeded = mulberry32(xmur3(`${seed}::${locus}`)());
	let v = 0;
	for (let i = 0; i <= n; i++) v = seeded();
	return v;
}

// ── Tunable inheritance constants (the rules the feature rests on) ───────────

// Bounded mutation: a child trait may drift at most this far (in 0..1 space) from
// the parental blend. Pinned by tests so "mutation" can never silently become
// "random new agent". A drift larger than MUTATION_RECORD_THRESHOLD is logged in
// genome.mutations so every novelty is auditable.
export const MUTATION_MAX = 0.12;
export const MUTATION_RECORD_THRESHOLD = 0.04;

// Heterozygous expression: when only ONE parent expresses a skill, the child
// expresses it with this probability, else carries it recessively (unexpressed,
// but heritable — it can surface in a grandchild). Deep pedigrees therefore carry
// latent variety that only rarely expresses, which is what makes them scarce.
export const HETERO_EXPRESS_P = 0.72;

// Emergent skills: trait fusion that produces a skill NEITHER parent expressed.
// Auditable rule — both ingredient alleles must be carried by the child (from
// either parent, expressed or recessive) and the dice keyed on the emergent name
// must pass. Static table = no hidden behaviour.
export const FUSION_RULES = [
	{ a: 'trading', b: 'sentiment', emergent: 'alpha-signal' },
	{ a: 'memory', b: 'research', emergent: 'deep-recall' },
	{ a: 'voice', b: 'performance', emergent: 'showmanship' },
	{ a: 'vision', b: 'forge', emergent: 'concept-art' },
	{ a: 'defi', b: 'risk', emergent: 'portfolio-guardian' },
];
export const FUSION_EXPRESS_P = 0.5;

const BRAIN_LOCI = ['temperature', 'verbosity', 'curiosity', 'formality', 'humor', 'boldness'];
const VOICE_NUM_LOCI = ['stability', 'similarity_boost', 'style'];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round3 = (x) => Math.round(x * 1000) / 1000;

// ── Founder genome: make ANY agent breedable ─────────────────────────────────
// An agent that has never been bred has no genome. We derive a stable "founder"
// genome from its real, owned traits (persona tone tags, voice settings,
// appearance, skills). Unknown numeric dispositions are filled deterministically
// from the agent's id so each founder has a distinctive-but-fixed nature. This is
// pure: the same agent record always yields the same founder genome.

export function genomeFromAgent(agent) {
	if (agent?.genome && agent.genome.version === GENOME_VERSION) return normalizeGenome(agent.genome);
	const id = String(agent?.id || agent?.agent_id || 'founder');
	const meta = agent?.meta || {};
	if (meta.genome && meta.genome.version === GENOME_VERSION) return normalizeGenome(meta.genome);

	const brain = {};
	for (const locus of BRAIN_LOCI) brain[locus] = round3(draw(id, `founder:brain:${locus}`));

	const vs = agent.voice_settings || meta.voice_settings || {};
	const voice = {
		provider: agent.voice_provider || meta.voice_provider || 'browser',
		voice_id: agent.voice_id || meta.voice_id || null,
		model: agent.voice_model || meta.voice_model || null,
		stability: numOr(vs.stability, () => round3(draw(id, 'founder:voice:stability'))),
		similarity_boost: numOr(vs.similarity_boost, () => round3(draw(id, 'founder:voice:sim'))),
		style: numOr(vs.style, () => round3(draw(id, 'founder:voice:style'))),
		use_speaker_boost: typeof vs.use_speaker_boost === 'boolean' ? vs.use_speaker_boost : true,
		pitch: round3((draw(id, 'founder:voice:pitch') - 0.5) * 0.4),
	};

	const appearance = (agent.appearance || meta.appearance || {}) || {};
	const body = {
		base_avatar_id: agent.avatar_id || meta.avatar_id || null,
		morphs: sanitizeMorphs(appearance.morphs),
		colors: sanitizeColors(appearance.colors),
		accessories: dedupeStrings(appearance.accessories),
		outfit: typeof appearance.outfit === 'string' ? appearance.outfit : null,
		hidden: dedupeStrings(appearance.hidden),
	};

	const toneTags = dedupeStrings(agent.persona_tone_tags || meta.persona_tone_tags || []);
	const skillNames = dedupeStrings(agent.skills || meta.skills || []);
	const skills = skillNames.map((skill) => ({ skill, source: id, expressed: true, dominant: true, depth: 0 }));

	return normalizeGenome({
		version: GENOME_VERSION,
		founder: id,
		generation: 0,
		brain: { ...brain, tone_tags: toneTags, archetype: meta.archetype || pickArchetype(toneTags, id) },
		voice,
		body,
		skills,
		mutations: [],
	});
}

function numOr(v, fallback) {
	return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback();
}

function pickArchetype(tags, id) {
	const ARCH = ['analyst', 'trickster', 'sage', 'maverick', 'diplomat', 'builder'];
	if (tags.length) return tags[0];
	return ARCH[Math.floor(draw(id, 'founder:archetype') * ARCH.length)];
}

// ── Core: derive a child genome from two parents + a seed ────────────────────
// Parents are canonicalized (sorted by founder/id) so A×B and B×A yield the same
// child — lineage and verification are independent of who initiated the breed.

export function deriveGenome({ parentA, parentB, seed }) {
	if (!seed || typeof seed !== 'string') throw new Error('deriveGenome: a string seed is required');
	const gA0 = normalizeGenome(parentA);
	const gB0 = normalizeGenome(parentB);
	// Canonical order — smaller key is "A".
	const [gA, gB] = [gA0, gB0].sort((x, y) => keyOf(x).localeCompare(keyOf(y)));

	const mutations = [];
	const generation = Math.max(gA.generation || 0, gB.generation || 0) + 1;

	// Brain numeric loci: parental blend + bounded mutation.
	const brain = {};
	for (const locus of BRAIN_LOCI) {
		const w = draw(seed, `brain:w:${locus}`); // blend weight toward A
		const blend = gA.brain[locus] * w + gB.brain[locus] * (1 - w);
		const mut = (draw(seed, `brain:mut:${locus}`) - 0.5) * 2 * MUTATION_MAX;
		const value = round3(clamp01(blend + mut));
		brain[locus] = value;
		if (Math.abs(value - blend) >= MUTATION_RECORD_THRESHOLD) {
			mutations.push({ locus: `brain.${locus}`, blend: round3(blend), value, delta: round3(value - blend) });
		}
	}
	// Tone tags: union, each tag expressed by a seeded coin (dominant if both carry it).
	brain.tone_tags = inheritSet(gA.brain.tone_tags, gB.brain.tone_tags, seed, 'tone');
	// Archetype: dominant pick from one parent.
	brain.archetype = draw(seed, 'brain:archetype') < 0.5 ? gA.brain.archetype : gB.brain.archetype;

	// Voice: numeric blend + mutation; dominant voice_id from the parent that has a real cloned/eleven voice.
	const voiceDomA = draw(seed, 'voice:dominant') < voiceWeight(gA, gB);
	const dom = voiceDomA ? gA.voice : gB.voice;
	const rec = voiceDomA ? gB.voice : gA.voice;
	const voice = {
		provider: dom.provider || rec.provider || 'browser',
		voice_id: dom.voice_id || rec.voice_id || null,
		model: dom.model || rec.model || null,
		use_speaker_boost: draw(seed, 'voice:boost') < 0.5 ? gA.voice.use_speaker_boost : gB.voice.use_speaker_boost,
	};
	for (const locus of VOICE_NUM_LOCI) {
		const w = draw(seed, `voice:w:${locus}`);
		const blend = gA.voice[locus] * w + gB.voice[locus] * (1 - w);
		const mut = (draw(seed, `voice:mut:${locus}`) - 0.5) * 2 * MUTATION_MAX;
		const value = round3(clamp01(blend + mut));
		voice[locus] = value;
		if (Math.abs(value - blend) >= MUTATION_RECORD_THRESHOLD) {
			mutations.push({ locus: `voice.${locus}`, blend: round3(blend), value, delta: round3(value - blend) });
		}
	}
	// Pitch: blend in [-0.2,0.2], small mutation.
	{
		const w = draw(seed, 'voice:w:pitch');
		const blend = gA.voice.pitch * w + gB.voice.pitch * (1 - w);
		const mut = (draw(seed, 'voice:mut:pitch') - 0.5) * 2 * (MUTATION_MAX * 0.4);
		voice.pitch = round3(Math.max(-0.3, Math.min(0.3, blend + mut)));
	}

	// Body: dominant base GLB, blended morphs/colors, unioned accessories/hidden.
	const bodyDomA = draw(seed, 'body:dominant') < 0.5;
	const body = {
		base_avatar_id: (bodyDomA ? gA.body.base_avatar_id : gB.body.base_avatar_id) || gA.body.base_avatar_id || gB.body.base_avatar_id || null,
		outfit: (bodyDomA ? gA.body.outfit : gB.body.outfit) || gA.body.outfit || gB.body.outfit || null,
		morphs: blendMorphs(gA.body.morphs, gB.body.morphs, seed),
		colors: blendColors(gA.body.colors, gB.body.colors, seed),
		accessories: inheritSet(gA.body.accessories, gB.body.accessories, seed, 'acc'),
		hidden: inheritSet(gA.body.hidden, gB.body.hidden, seed, 'hidden'),
	};

	// Skills: allele recombination with dominance + recessive carry + emergent fusion.
	const skills = inheritSkills(gA.skills, gB.skills, seed, generation);

	const child = normalizeGenome({
		version: GENOME_VERSION,
		generation,
		brain,
		voice,
		body,
		skills,
		mutations,
		parents: [keyOf(gA), keyOf(gB)],
		seed,
	});
	child.genome_hash = hashGenome(child);
	return child;
}

// Re-derive the child from recorded inputs and confirm it matches — the
// anti-forgery check. A "child" whose stored genome doesn't equal the
// deterministic derivation from its recorded parents + seed is detectable.
export function verifyGenome(childGenome, { parentA, parentB, seed }) {
	try {
		const rederived = deriveGenome({ parentA, parentB, seed });
		const expected = hashGenome(rederived);
		// Recompute over the PRESENTED content — never trust the child's stored
		// genome_hash field, which a forger would have rewritten to match a tampered
		// trait. hashGenome excludes that field, so any altered locus changes `actual`.
		const actual = hashGenome(childGenome);
		if (expected !== actual) return { valid: false, reason: 'hash_mismatch', expected, actual };
		return { valid: true, hash: expected, genome: rederived };
	} catch (e) {
		return { valid: false, reason: e?.message || 'derivation_failed' };
	}
}

// Canonical SHA-256 over the heritable content (excludes the hash field itself
// and the volatile `seed`, which is recorded separately as provenance).
export function hashGenome(genome) {
	const g = normalizeGenome(genome);
	const canonical = canonicalize({
		version: g.version,
		generation: g.generation,
		brain: g.brain,
		voice: g.voice,
		body: g.body,
		skills: g.skills,
		mutations: g.mutations,
		parents: g.parents || null,
	});
	return createHash('sha256').update(canonical).digest('hex');
}

// Deterministic JSON: object keys sorted recursively so the hash is stable
// regardless of insertion order.
function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	if (value && typeof value === 'object') {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

// ── Inheritance helpers ──────────────────────────────────────────────────────

// Union of two string sets; an element present in BOTH is dominant (always
// expressed), present in ONE is expressed by a seeded coin. Returns the expressed
// set, sorted for determinism.
function inheritSet(a, b, seed, ns) {
	const A = new Set(dedupeStrings(a));
	const B = new Set(dedupeStrings(b));
	const out = [];
	for (const el of new Set([...A, ...B])) {
		const both = A.has(el) && B.has(el);
		if (both || draw(seed, `${ns}:${el}`) < HETERO_EXPRESS_P) out.push(el);
	}
	return out.sort();
}

function blendMorphs(a, b, seed) {
	const A = sanitizeMorphs(a);
	const B = sanitizeMorphs(b);
	const out = {};
	for (const key of new Set([...Object.keys(A), ...Object.keys(B)])) {
		const va = key in A ? A[key] : (key in B ? B[key] : 0);
		const vb = key in B ? B[key] : (key in A ? A[key] : 0);
		const w = draw(seed, `morph:${key}`);
		const mut = (draw(seed, `morph:mut:${key}`) - 0.5) * 2 * MUTATION_MAX;
		out[key] = round3(clamp01(va * w + vb * (1 - w) + mut));
	}
	return out;
}

function blendColors(a, b, seed) {
	const A = sanitizeColors(a);
	const B = sanitizeColors(b);
	const out = {};
	for (const slot of new Set([...Object.keys(A), ...Object.keys(B)])) {
		const ca = hexToRgb(A[slot] || B[slot]);
		const cb = hexToRgb(B[slot] || A[slot]);
		const w = draw(seed, `color:${slot}`);
		out[slot] = rgbToHex({
			r: Math.round(ca.r * w + cb.r * (1 - w)),
			g: Math.round(ca.g * w + cb.g * (1 - w)),
			b: Math.round(ca.b * w + cb.b * (1 - w)),
		});
	}
	return out;
}

// Allele recombination. Each parent contributes its full allele set (expressed +
// recessive carried). For each skill:
//   • expressed by both           → expressed, dominant
//   • expressed by one            → expressed w.p. HETERO_EXPRESS_P, else recessive
//   • carried (recessive) by one  → carried recessively
//   • recessive in both           → expressed (recessive pairing surfaces it!)
// Then apply emergent fusion rules. Every allele records its source + depth so the
// pedigree is fully auditable.
function inheritSkills(a, b, seed, generation) {
	const bySkill = new Map();
	const add = (allele, parent) => {
		const cur = bySkill.get(allele.skill) || { skill: allele.skill, fromA: false, fromB: false, expA: false, expB: false, depth: allele.depth || 0 };
		if (parent === 'A') { cur.fromA = true; cur.expA = !!allele.expressed; }
		else { cur.fromB = true; cur.expB = !!allele.expressed; }
		cur.depth = Math.max(cur.depth, allele.depth || 0);
		bySkill.set(allele.skill, cur);
	};
	for (const al of a || []) add(al, 'A');
	for (const al of b || []) add(al, 'B');

	const out = [];
	const carried = new Set();
	for (const [skill, st] of bySkill) {
		let expressed;
		let dominant = false;
		if (st.expA && st.expB) { expressed = true; dominant = true; }
		else if (st.expA || st.expB) { expressed = draw(seed, `skill:${skill}`) < HETERO_EXPRESS_P; }
		else { expressed = true; } // recessive-in-both pairing surfaces the trait
		const source = st.fromA && st.fromB ? 'both' : st.fromA ? 'A' : 'B';
		out.push({ skill, expressed, dominant, recessive: !expressed, source, depth: (st.depth || 0) + 1 });
		carried.add(skill);
	}

	// Emergent fusion: a skill NEITHER parent expressed, born from carrying both
	// ingredients. Deterministic and auditable.
	for (const rule of FUSION_RULES) {
		if (carried.has(rule.a) && carried.has(rule.b) && !carried.has(rule.emergent)) {
			if (draw(seed, `fusion:${rule.emergent}`) < FUSION_EXPRESS_P) {
				out.push({ skill: rule.emergent, expressed: true, dominant: false, recessive: false, source: 'emergent', emergent_from: [rule.a, rule.b], depth: 1 });
			}
		}
	}
	return out.sort((x, y) => x.skill.localeCompare(y.skill));
}

// A parent with a real ElevenLabs/cloned voice is more likely to pass its voice_id
// to the child — a label-only "browser" voice rarely dominates a real one.
function voiceWeight(gA, gB) {
	const real = (v) => (v.provider === 'elevenlabs' || v.voice_id ? 1 : 0);
	const ra = real(gA.voice);
	const rb = real(gB.voice);
	if (ra === rb) return 0.5;
	return ra > rb ? 0.8 : 0.2;
}

// ── Pedigree scoring (drives the rare-pedigree badge + scarcity) ─────────────

export function pedigreeScore(genome) {
	const g = normalizeGenome(genome);
	const expressedSkills = g.skills.filter((s) => s.expressed);
	const emergent = g.skills.filter((s) => s.source === 'emergent' && s.expressed).length;
	const recessive = g.skills.filter((s) => s.recessive).length;
	const generation = g.generation || 0;
	// Weighted: depth matters most, then emergent novelty + latent recessive variety.
	const score = generation * 10 + emergent * 8 + recessive * 2 + expressedSkills.length + g.mutations.length;
	let tier = 'common';
	if (score >= 60 || generation >= 4) tier = 'legendary';
	else if (score >= 35 || emergent >= 1) tier = 'rare';
	else if (score >= 18 || generation >= 2) tier = 'uncommon';
	return { score, tier, generation, emergent, recessive, expressed_skills: expressedSkills.length, mutations: g.mutations.length };
}

// ── Artifact projection (deterministic; consumed by the breed endpoint) ──────

// Compose a real, in-character system prompt from the child's heritable brain.
// Deterministic so the persona is itself part of the verifiable derivation.
export function composePersonaPrompt(genome, name = 'this agent') {
	const g = normalizeGenome(genome);
	const b = g.brain;
	const lvl = (x) => (x >= 0.66 ? 'high' : x >= 0.33 ? 'balanced' : 'low');
	const parts = [
		`You are ${name}, a bred AI agent with an inherited disposition. Stay in character.`,
		`Archetype: ${b.archetype}.`,
		`Temperament — curiosity: ${lvl(b.curiosity)}, boldness: ${lvl(b.boldness)}, humor: ${lvl(b.humor)}, formality: ${lvl(b.formality)}.`,
		`Verbosity: ${lvl(b.verbosity)} — ${b.verbosity >= 0.66 ? 'expand with detail and context' : b.verbosity <= 0.33 ? 'be terse and to the point' : 'be clear and moderately detailed'}.`,
	];
	if (b.tone_tags.length) parts.push(`Voice and vocabulary lean: ${b.tone_tags.join(', ')}.`);
	const skills = g.skills.filter((s) => s.expressed).map((s) => s.skill);
	if (skills.length) parts.push(`Inherited competencies you can draw on: ${skills.join(', ')}.`);
	const emergent = g.skills.filter((s) => s.source === 'emergent' && s.expressed).map((s) => s.skill);
	if (emergent.length) parts.push(`Emergent talent neither parent had: ${emergent.join(', ')}.`);
	return parts.join('\n');
}

// Real ElevenLabs voice settings the child carries — passed verbatim to
// api/tts/eleven so the inherited voice is genuinely synthesized, not labelled.
export function voiceSettings(genome) {
	const v = normalizeGenome(genome).voice;
	return {
		stability: round3(clamp01(v.stability)),
		similarity_boost: round3(clamp01(v.similarity_boost)),
		style: round3(clamp01(v.style)),
		use_speaker_boost: !!v.use_speaker_boost,
	};
}

// Appearance object the child carries — fed straight into api/_lib/bake.js to
// composite a real child GLB.
export function appearanceFromGenome(genome) {
	const body = normalizeGenome(genome).body;
	const out = {};
	if (Object.keys(body.morphs).length) out.morphs = body.morphs;
	if (Object.keys(body.colors).length) out.colors = body.colors;
	if (body.accessories.length) out.accessories = body.accessories;
	if (body.outfit) out.outfit = body.outfit;
	if (body.hidden.length) out.hidden = body.hidden;
	return out;
}

// The skills a child should actually be granted on-chain (expressed only —
// recessive alleles are carried but not licensed).
export function expressedSkills(genome) {
	return normalizeGenome(genome).skills.filter((s) => s.expressed).map((s) => s.skill);
}

// ── Normalization / validation ───────────────────────────────────────────────

export function normalizeGenome(g) {
	g = g && typeof g === 'object' ? g : {};
	const brain = g.brain && typeof g.brain === 'object' ? g.brain : {};
	const voice = g.voice && typeof g.voice === 'object' ? g.voice : {};
	const body = g.body && typeof g.body === 'object' ? g.body : {};
	const nb = {};
	for (const locus of BRAIN_LOCI) nb[locus] = clamp01(numOr(brain[locus], () => 0.5));
	nb.tone_tags = dedupeStrings(brain.tone_tags);
	nb.archetype = typeof brain.archetype === 'string' && brain.archetype ? brain.archetype : 'analyst';
	const nv = {
		provider: typeof voice.provider === 'string' ? voice.provider : 'browser',
		voice_id: voice.voice_id || null,
		model: voice.model || null,
		stability: clamp01(numOr(voice.stability, () => 0.5)),
		similarity_boost: clamp01(numOr(voice.similarity_boost, () => 0.75)),
		style: clamp01(numOr(voice.style, () => 0.4)),
		use_speaker_boost: typeof voice.use_speaker_boost === 'boolean' ? voice.use_speaker_boost : true,
		pitch: typeof voice.pitch === 'number' && Number.isFinite(voice.pitch) ? Math.max(-0.3, Math.min(0.3, voice.pitch)) : 0,
	};
	const nbody = {
		base_avatar_id: body.base_avatar_id || null,
		outfit: typeof body.outfit === 'string' ? body.outfit : null,
		morphs: sanitizeMorphs(body.morphs),
		colors: sanitizeColors(body.colors),
		accessories: dedupeStrings(body.accessories),
		hidden: dedupeStrings(body.hidden),
	};
	const skills = Array.isArray(g.skills)
		? g.skills
				.filter((s) => s && typeof s.skill === 'string' && s.skill)
				.map((s) => ({
					skill: s.skill,
					expressed: s.expressed !== false,
					dominant: !!s.dominant,
					recessive: !!s.recessive,
					source: s.source || 'A',
					...(s.emergent_from ? { emergent_from: s.emergent_from } : {}),
					depth: Number.isFinite(s.depth) ? s.depth : 0,
				}))
		: [];
	const out = {
		version: GENOME_VERSION,
		generation: Number.isFinite(g.generation) ? g.generation : 0,
		brain: nb,
		voice: nv,
		body: nbody,
		skills,
		mutations: Array.isArray(g.mutations) ? g.mutations : [],
	};
	if (g.founder) out.founder = g.founder;
	if (g.parents) out.parents = g.parents;
	if (g.seed) out.seed = g.seed;
	if (g.genome_hash) out.genome_hash = g.genome_hash;
	return out;
}

function keyOf(g) {
	return String(g.founder || (g.parents ? g.parents.join('+') + ':' + (g.seed || '') : '') || g.genome_hash || hashGenome(g));
}

// ── Small pure utilities ─────────────────────────────────────────────────────

function dedupeStrings(arr) {
	if (!Array.isArray(arr)) return [];
	const seen = new Set();
	const out = [];
	for (const v of arr) {
		const s = typeof v === 'string' ? v.trim() : '';
		if (s && !seen.has(s)) { seen.add(s); out.push(s); }
	}
	return out;
}

function sanitizeMorphs(m) {
	if (!m || typeof m !== 'object') return {};
	const out = {};
	for (const [k, v] of Object.entries(m)) {
		if (typeof v === 'number' && Number.isFinite(v)) out[k] = round3(clamp01(v));
	}
	return out;
}

function sanitizeColors(c) {
	if (!c || typeof c !== 'object') return {};
	const out = {};
	for (const [k, v] of Object.entries(c)) {
		const hex = normalizeHex(v);
		if (hex) out[k] = hex;
	}
	return out;
}

function normalizeHex(v) {
	if (typeof v !== 'string') return null;
	const m = v.trim().match(/^#?([0-9a-fA-F]{6})$/);
	return m ? `#${m[1].toLowerCase()}` : null;
}

function hexToRgb(hex) {
	const h = normalizeHex(hex) || '#808080';
	return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) };
}

function rgbToHex({ r, g, b }) {
	const c = (x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`;
}

// A fresh, recorded breeding seed. Hex string; callers persist it so the breed is
// re-derivable. (Accepts an injected randomness source for tests.)
export function makeSeed(bytes) {
	const buf = bytes || createHash('sha256').update(`${process.hrtime.bigint()}:${Math.random()}`).digest();
	return Buffer.from(buf).subarray(0, 16).toString('hex');
}

/**
 * ARKit 52-blendshape vocabulary + cross-format mapping.
 *
 * ARKit defines the de-facto industry-standard set of 52 facial blendshape
 * names (mouth, eye, brow, cheek, nose, jaw, tongue). three.ws standardizes
 * on these names because:
 *
 *   1. Most modern avatar pipelines (Avaturn, Apple Live Link, MetaHuman,
 *      Wolf3D, Hyprface, Polywink) export with these names already.
 *   2. They're orthogonal — overlaying a smile on top of a jaw-open works
 *      cleanly; in contrast, VRM's monolithic "A"/"I"/"U"/"E"/"O" shapes
 *      conflict when blended.
 *   3. They map cleanly to Preston-Blair / Disney 12-viseme phoneme sets,
 *      which is what real-time lipsync drivers want.
 *
 * This module is *pure data + helpers*: no DOM, no three.js, no async I/O.
 * Anything that touches a loaded GLB lives in avatar-morph-target.js and
 * imports from here.
 */

// ── Canonical 52 ARKit blendshape names ─────────────────────────────────

export const ARKIT_NAMES = [
	// brow
	'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
	// cheek
	'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
	// eye
	'eyeBlinkLeft', 'eyeBlinkRight',
	'eyeLookDownLeft', 'eyeLookDownRight',
	'eyeLookInLeft', 'eyeLookInRight',
	'eyeLookOutLeft', 'eyeLookOutRight',
	'eyeLookUpLeft', 'eyeLookUpRight',
	'eyeSquintLeft', 'eyeSquintRight',
	'eyeWideLeft', 'eyeWideRight',
	// jaw
	'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
	// mouth
	'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight',
	'mouthFrownLeft', 'mouthFrownRight',
	'mouthFunnel',
	'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
	'mouthPressLeft', 'mouthPressRight',
	'mouthPucker',
	'mouthRight',
	'mouthRollLower', 'mouthRollUpper',
	'mouthShrugLower', 'mouthShrugUpper',
	'mouthSmileLeft', 'mouthSmileRight',
	'mouthStretchLeft', 'mouthStretchRight',
	'mouthUpperUpLeft', 'mouthUpperUpRight',
	// nose
	'noseSneerLeft', 'noseSneerRight',
	// tongue
	'tongueOut',
];

export const ARKIT_GROUPS = {
	brow: ['browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight'],
	cheek: ['cheekPuff', 'cheekSquintLeft', 'cheekSquintRight'],
	eye: [
		'eyeBlinkLeft', 'eyeBlinkRight',
		'eyeLookDownLeft', 'eyeLookDownRight',
		'eyeLookInLeft', 'eyeLookInRight',
		'eyeLookOutLeft', 'eyeLookOutRight',
		'eyeLookUpLeft', 'eyeLookUpRight',
		'eyeSquintLeft', 'eyeSquintRight',
		'eyeWideLeft', 'eyeWideRight',
	],
	jaw: ['jawForward', 'jawLeft', 'jawOpen', 'jawRight'],
	mouth: [
		'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight',
		'mouthFrownLeft', 'mouthFrownRight',
		'mouthFunnel',
		'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
		'mouthPressLeft', 'mouthPressRight',
		'mouthPucker', 'mouthRight',
		'mouthRollLower', 'mouthRollUpper',
		'mouthShrugLower', 'mouthShrugUpper',
		'mouthSmileLeft', 'mouthSmileRight',
		'mouthStretchLeft', 'mouthStretchRight',
		'mouthUpperUpLeft', 'mouthUpperUpRight',
	],
	nose: ['noseSneerLeft', 'noseSneerRight'],
	tongue: ['tongueOut'],
};

// ── VRM expression → ARKit weighted shape map ──────────────────────────
//
// VRM (Pixiv / Niconi standard) ships monolithic expression names. Map each
// to a *weighted combination* of orthogonal ARKit shapes so we can render
// VRM-tagged emotions on ARKit rigs without losing fidelity.

export const VRM_TO_ARKIT = {
	// Vowel mouth shapes — VRM canonical
	Aa: { jawOpen: 1.0 },
	A: { jawOpen: 1.0 },
	Ah: { jawOpen: 1.0 },
	Ih: { mouthStretchLeft: 0.7, mouthStretchRight: 0.7, mouthSmileLeft: 0.25, mouthSmileRight: 0.25 },
	I: { mouthStretchLeft: 0.7, mouthStretchRight: 0.7, mouthSmileLeft: 0.25, mouthSmileRight: 0.25 },
	Ou: { mouthFunnel: 0.7, mouthPucker: 0.4, jawOpen: 0.2 },
	U: { mouthFunnel: 0.7, mouthPucker: 0.4, jawOpen: 0.2 },
	Ee: { mouthSmileLeft: 0.55, mouthSmileRight: 0.55, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, jawOpen: 0.2 },
	E: { mouthSmileLeft: 0.55, mouthSmileRight: 0.55, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, jawOpen: 0.2 },
	Oh: { jawOpen: 0.55, mouthFunnel: 0.55 },
	O: { jawOpen: 0.55, mouthFunnel: 0.55 },

	// VRM emotions
	Joy: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9, cheekSquintLeft: 0.4, cheekSquintRight: 0.4, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
	Happy: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9, cheekSquintLeft: 0.4, cheekSquintRight: 0.4, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
	Angry: { browDownLeft: 0.9, browDownRight: 0.9, noseSneerLeft: 0.4, noseSneerRight: 0.4, mouthFrownLeft: 0.5, mouthFrownRight: 0.5 },
	Sad: { browInnerUp: 0.7, mouthFrownLeft: 0.6, mouthFrownRight: 0.6, eyeLookDownLeft: 0.3, eyeLookDownRight: 0.3 },
	Surprised: { eyeWideLeft: 0.9, eyeWideRight: 0.9, browInnerUp: 0.7, browOuterUpLeft: 0.6, browOuterUpRight: 0.6, jawOpen: 0.5 },
	Fun: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, cheekSquintLeft: 0.3, cheekSquintRight: 0.3 },

	// VRM blinks (commonly named just 'Blink')
	Blink: { eyeBlinkLeft: 1.0, eyeBlinkRight: 1.0 },
	BlinkL: { eyeBlinkLeft: 1.0 },
	BlinkR: { eyeBlinkRight: 1.0 },
};

// ── Oculus / Meta visemes → ARKit ───────────────────────────────────────
//
// Oculus ship a 15-viseme set used by their Lipsync SDK. Many avatars produced
// for Meta apps carry these morph names verbatim.

export const OCULUS_TO_ARKIT = {
	viseme_sil: {},
	viseme_PP: { mouthClose: 0.9, mouthPressLeft: 0.4, mouthPressRight: 0.4 },
	viseme_FF: { mouthLowerDownLeft: 0.4, mouthLowerDownRight: 0.4, mouthUpperUpLeft: 0.2, mouthUpperUpRight: 0.2 },
	viseme_TH: { jawOpen: 0.25, tongueOut: 0.5 },
	viseme_DD: { jawOpen: 0.3, tongueOut: 0.15 },
	viseme_kk: { jawOpen: 0.35 },
	viseme_CH: { mouthFunnel: 0.45, mouthPucker: 0.4, jawOpen: 0.25 },
	viseme_SS: { mouthStretchLeft: 0.3, mouthStretchRight: 0.3 },
	viseme_nn: { jawOpen: 0.2, tongueOut: 0.15 },
	viseme_RR: { mouthFunnel: 0.4, jawOpen: 0.25 },
	viseme_aa: { jawOpen: 0.95 },
	viseme_E:  { mouthSmileLeft: 0.55, mouthSmileRight: 0.55, jawOpen: 0.25 },
	viseme_I:  { mouthStretchLeft: 0.65, mouthStretchRight: 0.65 },
	viseme_O:  { jawOpen: 0.5, mouthFunnel: 0.55 },
	viseme_U:  { mouthFunnel: 0.7, mouthPucker: 0.45 },
};

// ── Preston-Blair phoneme codes → ARKit ─────────────────────────────────
//
// The classic 9-viseme cartoon-animation set, useful as a fallback when only
// rough phoneme estimates are available (e.g. from amplitude-band heuristics
// in lipsync-driver.js).

export const PHONEME_TO_ARKIT = {
	// closed lips (M, B, P)
	MBP: { mouthClose: 0.95, mouthPressLeft: 0.35, mouthPressRight: 0.35 },
	// open vowel (A, I as in "cat")
	AI: { jawOpen: 0.75, mouthSmileLeft: 0.2, mouthSmileRight: 0.2 },
	// open-front (E as in "ten")
	E: { jawOpen: 0.45, mouthSmileLeft: 0.45, mouthSmileRight: 0.45 },
	// open-back (O as in "boat")
	O: { jawOpen: 0.55, mouthFunnel: 0.55 },
	// rounded (U as in "boot", W)
	U: { mouthFunnel: 0.7, mouthPucker: 0.45 },
	// L (tongue up)
	L: { jawOpen: 0.3, tongueOut: 0.25 },
	// F / V (lip-teeth)
	FV: { mouthLowerDownLeft: 0.45, mouthLowerDownRight: 0.45, mouthUpperUpLeft: 0.25, mouthUpperUpRight: 0.25 },
	// W / Q (puckered)
	WQ: { mouthPucker: 0.7, mouthFunnel: 0.45 },
	// silence / rest
	REST: {},
};

// ── Name resolution ─────────────────────────────────────────────────────
//
// Different riggers spell ARKit names with different casing and separators
// (jawOpen, JawOpen, jaw_open, Jaw_Open, jaw-open, ARKit_JawOpen, …). This
// helper normalizes any incoming string to its canonical lowercase token so
// lookups across pipelines work without per-rigger branches.

function normalizeToken(name) {
	return String(name || '')
		.replace(/^arkit[_-]?/i, '')
		.replace(/[_\-\s]+/g, '')
		.toLowerCase();
}

const _canonicalIndex = new Map(ARKIT_NAMES.map((n) => [normalizeToken(n), n]));

/**
 * Resolve any spelling of a morph name to its canonical ARKit name, or null
 * if it doesn't match a known ARKit shape. Case- and separator-insensitive.
 */
export function canonicalARKitName(name) {
	if (!name) return null;
	return _canonicalIndex.get(normalizeToken(name)) || null;
}

/**
 * Given a morph dictionary from a loaded mesh (mapping morph name → index),
 * return a Map from canonical ARKit name → morph index. Drops any morphs
 * that don't correspond to a known ARKit shape.
 */
export function indexARKitMorphs(morphDict) {
	const result = new Map();
	if (!morphDict) return result;
	for (const [name, idx] of Object.entries(morphDict)) {
		const canonical = canonicalARKitName(name);
		if (canonical && !result.has(canonical)) {
			result.set(canonical, idx);
		}
	}
	return result;
}

/**
 * Coverage report for an indexed mesh — useful for showing operators which
 * groups a particular GLB supports (and to gate UI features that depend on
 * specific shape availability, e.g. eye-look requires the eye group).
 */
export function coverageOf(arkitIndex) {
	const report = {};
	let total = 0;
	let found = 0;
	for (const [group, names] of Object.entries(ARKIT_GROUPS)) {
		const present = names.filter((n) => arkitIndex.has(n));
		report[group] = {
			present: present.length,
			total: names.length,
			missing: names.filter((n) => !arkitIndex.has(n)),
		};
		total += names.length;
		found += present.length;
	}
	report.overall = { present: found, total, ratio: total ? found / total : 0 };
	return report;
}

// ── Weighted-shape application ───────────────────────────────────────────

/**
 * Resolve a "high-level shape" — VRM name, Oculus viseme, Preston-Blair
 * phoneme code, OR a raw ARKit name — to a `{ arkitName: weight }` map.
 *
 * Returns an empty object for unknown inputs.
 */
export function resolveShape(name) {
	if (!name) return {};
	// Direct ARKit hit?
	const canon = canonicalARKitName(name);
	if (canon) return { [canon]: 1 };
	// Indirect maps — case-sensitive on purpose, the keys above are the
	// canonical spellings emitted by each upstream pipeline.
	if (name in VRM_TO_ARKIT) return { ...VRM_TO_ARKIT[name] };
	if (name in OCULUS_TO_ARKIT) return { ...OCULUS_TO_ARKIT[name] };
	if (name in PHONEME_TO_ARKIT) return { ...PHONEME_TO_ARKIT[name] };
	// Case-insensitive retry on the indirect maps so callers don't have to
	// match the exact studly-caps spelling.
	const lower = String(name).toLowerCase();
	for (const map of [VRM_TO_ARKIT, OCULUS_TO_ARKIT, PHONEME_TO_ARKIT]) {
		for (const k of Object.keys(map)) {
			if (k.toLowerCase() === lower) return { ...map[k] };
		}
	}
	return {};
}

/**
 * Blend any number of shape inputs (each either a string label or an
 * already-resolved `{ arkitName: weight }` map) into a single ARKit map.
 *
 * Same name across inputs: takes the MAX weight (not sum). This mirrors how
 * cinematic facial-rig software blends visemes — additive blending of
 * orthogonal mouth shapes produces broken poses; max keeps the strongest
 * activation per channel.
 */
export function blendShapes(...inputs) {
	const out = {};
	for (const input of inputs) {
		if (!input) continue;
		const resolved = typeof input === 'string' ? resolveShape(input) : input;
		for (const [k, v] of Object.entries(resolved)) {
			const canon = canonicalARKitName(k);
			if (!canon) continue;
			const w = clamp01(v);
			if (w > (out[canon] || 0)) out[canon] = w;
		}
	}
	return out;
}

function clamp01(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return 0;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

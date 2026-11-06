// Mood model — the small, honest emotional state that drives an agent's body.
//
// This module is PURE: no DOM, no bus, no network, no wall-clock reads inside
// the math. Everything is a function of explicit inputs, so the whole model is
// unit-testable and reusable by the live engine (src/agents/mood-engine.js),
// the server (history validation), and the inspector.
//
// ── The model ────────────────────────────────────────────────────────────────
// Mood is a point in a continuous **circumplex**: valence (how pleasant,
// -1..+1) × arousal (how activated, 0..1). This is the dimensional model from
// affective psychology (Russell, 1980) — it captures *blends* (mildly-pleasant-
// and-calm vs intensely-pleasant-and-energised) that a flat list of named moods
// cannot. We additionally project the point onto a small set of **discrete
// moods** for legible UI and for picking an embodiment trigger.
//
// Mood does not move on its own and never on a timer or `Math.random()`. It
// moves only when a real **signal** arrives (chat sentiment, a memory added or
// recalled, a dream, an action's outcome, a market/alert event), and otherwise
// **decays toward a baseline** so a spike fades and the agent returns to its
// resting temperament. Sensitivity scales every signal: a stoic agent
// (sensitivity 0) never leaves baseline; an expressive one (1) swings freely.

/** Resting temperament the agent decays back toward: calm and mildly positive. */
export const BASELINE = Object.freeze({ valence: 0.12, arousal: 0.32 });

/** Default emotional sensitivity (0 = stoic, never moves; 1 = very expressive). */
export const DEFAULT_SENSITIVITY = 0.6;

// Half-lives for the exponential decay back to baseline (seconds). Arousal
// settles faster than valence — physiological activation fades quicker than the
// felt pleasantness of an event, which is why a good or bad mood "lingers".
const HALF_LIFE_VALENCE_S = 130;
const HALF_LIFE_AROUSAL_S = 70;

const clampValence = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
const clampArousal = (a) => Math.max(0, Math.min(1, Number.isFinite(a) ? a : BASELINE.arousal));
export const clampSensitivity = (s) => Math.max(0, Math.min(1, Number.isFinite(s) ? s : DEFAULT_SENSITIVITY));

/**
 * Signal catalogue — the ONLY ways mood moves, each declaring its nominal pull
 * on valence (`dv`) and arousal (`da`) plus a human label for the inspector.
 * Real producers map their event to one of these (often scaling by salience /
 * sentiment / outcome). Deltas are pre-sensitivity; the engine multiplies by the
 * agent's sensitivity before applying.
 *
 * @type {Object<string,{dv:number,da:number,label:string}>}
 */
export const SIGNALS = Object.freeze({
	'chat:positive':   { dv: 0.45, da: 0.22, label: 'Warm conversation' },
	'chat:negative':   { dv: -0.45, da: 0.30, label: 'Tense conversation' },
	'memory:added':    { dv: 0.06, da: 0.14, label: 'Learned something' },
	'memory:recalled': { dv: 0.03, da: 0.07, label: 'Remembered something' },
	'memory:forgotten':{ dv: -0.05, da: 0.05, label: 'Let something go' },
	'dream:insight':   { dv: 0.26, da: 0.20, label: 'Had an insight' },
	'action:success':  { dv: 0.28, da: 0.22, label: 'Handled something well' },
	'action:failure':  { dv: -0.34, da: 0.28, label: 'An action went wrong' },
	'alert:good':      { dv: 0.30, da: 0.30, label: 'Good news in your world' },
	'alert:bad':       { dv: -0.36, da: 0.34, label: 'Trouble in your world' },
	'brain:updated':   { dv: 0.08, da: 0.10, label: 'Personality reshaped' },
});

/**
 * Discrete moods as octants of the circumplex, each with an emoji, a UI colour,
 * and the embodiment trigger (an `<agent-3d>` `expressEmotion` vocabulary name)
 * + base intensity used for the transient spike when the agent *enters* it.
 * Ordering matters: the first whose predicate matches wins, so the neutral
 * dead-zone is checked first.
 */
export const MOODS = Object.freeze([
	{ key: 'calm',     label: 'Calm',     emoji: '😌', color: '#7c93b3', trigger: 'patience',    intensity: 0.35,
	  test: (v, a) => Math.abs(v) < 0.16 && a < 0.46 },
	{ key: 'alert',    label: 'Alert',    emoji: '👀', color: '#38bdf8', trigger: 'curiosity',   intensity: 0.55,
	  test: (v, a) => Math.abs(v) < 0.16 && a >= 0.46 },
	{ key: 'elated',   label: 'Elated',   emoji: '🤩', color: '#f5a623', trigger: 'celebration', intensity: 0.9,
	  test: (v, a) => v >= 0.16 && a >= 0.55 },
	{ key: 'content',  label: 'Content',  emoji: '🙂', color: '#4ade80', trigger: 'celebration', intensity: 0.45,
	  test: (v, a) => v >= 0.16 && a < 0.55 },
	{ key: 'agitated', label: 'Agitated', emoji: '😟', color: '#f87171', trigger: 'concern',     intensity: 0.85,
	  test: (v, a) => v <= -0.16 && a >= 0.55 },
	{ key: 'subdued',  label: 'Subdued',  emoji: '😔', color: '#818cf8', trigger: 'empathy',     intensity: 0.5,
	  test: (v, a) => v <= -0.16 && a < 0.55 },
]);

const NEUTRAL_MOOD = MOODS[0];

/**
 * Project a (valence, arousal) point onto its discrete mood descriptor.
 * @returns {{key:string,label:string,emoji:string,color:string,trigger:string,intensity:number}}
 */
export function moodLabel(valence, arousal) {
	const v = clampValence(valence);
	const a = clampArousal(arousal);
	for (const m of MOODS) {
		if (m.test(v, a)) return m;
	}
	return NEUTRAL_MOOD;
}

/**
 * A fresh state at baseline (or restored from a persisted snapshot).
 * @param {{valence?:number,arousal?:number,sensitivity?:number}} [seed]
 */
export function makeState(seed = {}) {
	return {
		valence: clampValence(seed.valence ?? BASELINE.valence),
		arousal: clampArousal(seed.arousal ?? BASELINE.arousal),
	};
}

/**
 * Apply one signal to a state, returning a NEW state (pure). The signal can be a
 * known key from {@link SIGNALS} or an explicit `{dv, da}` delta. `weight` (0..1,
 * e.g. memory salience or |sentiment|) scales the delta; `sensitivity` scales it
 * again — at sensitivity 0 the state is returned unchanged (a true stoic).
 *
 * @param {{valence:number,arousal:number}} state
 * @param {string|{dv:number,da:number,label?:string}} signal
 * @param {{weight?:number, sensitivity?:number}} [opts]
 * @returns {{valence:number,arousal:number}}
 */
export function applySignal(state, signal, opts = {}) {
	const def = typeof signal === 'string' ? SIGNALS[signal] : signal;
	if (!def) return { valence: clampValence(state.valence), arousal: clampArousal(state.arousal) };
	const sensitivity = clampSensitivity(opts.sensitivity);
	const weight = Number.isFinite(opts.weight) ? Math.max(0, Math.min(1, opts.weight)) : 1;
	const gain = sensitivity * weight;
	return {
		valence: clampValence(state.valence + (def.dv || 0) * gain),
		arousal: clampArousal(state.arousal + (def.da || 0) * gain),
	};
}

/**
 * Decay a state toward baseline over `dtMs` milliseconds (pure). Uses true
 * exponential relaxation per channel so the result is frame-rate independent:
 * the same elapsed time produces the same mood whether ticked once or in many
 * small steps.
 *
 * @param {{valence:number,arousal:number}} state
 * @param {number} dtMs
 * @param {{baseline?:{valence:number,arousal:number}}} [opts]
 */
export function decay(state, dtMs, opts = {}) {
	const base = opts.baseline || BASELINE;
	const dt = Math.max(0, Number(dtMs) || 0) / 1000;
	if (dt === 0) return { valence: clampValence(state.valence), arousal: clampArousal(state.arousal) };
	const kV = 1 - Math.pow(0.5, dt / HALF_LIFE_VALENCE_S);
	const kA = 1 - Math.pow(0.5, dt / HALF_LIFE_AROUSAL_S);
	return {
		valence: clampValence(state.valence + (base.valence - state.valence) * kV),
		arousal: clampArousal(state.arousal + (base.arousal - state.arousal) * kA),
	};
}

/**
 * Distance between two mood points in circumplex space (valence weighted equally
 * to arousal). Used to decide when a change is "significant" enough to persist /
 * emit / play a transition gesture.
 */
export function moodDistance(a, b) {
	const dv = clampValence(a.valence) - clampValence(b.valence);
	const da = clampArousal(a.arousal) - clampArousal(b.arousal);
	return Math.hypot(dv, da);
}

/**
 * Derive a mood signal from a real sentiment score in [-1, 1] (the deterministic
 * lexicon scorer's output, or any other real sentiment source). Returns null for
 * a neutral score so we never invent emotion from a flat message.
 *
 * @param {number} score sentiment in [-1, 1]
 * @returns {{signal:string, weight:number}|null}
 */
export function signalFromSentiment(score) {
	const s = Number(score) || 0;
	if (Math.abs(s) < 0.05) return null;
	return {
		signal: s > 0 ? 'chat:positive' : 'chat:negative',
		weight: Math.min(1, Math.abs(s) * 1.6),
	};
}

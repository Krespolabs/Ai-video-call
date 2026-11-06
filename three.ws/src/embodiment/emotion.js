/**
 * Lightweight emotion classifier + face/gesture descriptor for embodied agents.
 *
 * A persona speaks a turn of text; this module reads the text, picks the
 * emotion it most plausibly carries, and returns a renderable descriptor: an
 * idle loop to sit in, a body gesture to fire, and a set of ARKit-style face
 * blendshape weights scaled by intensity. The embodiment stage and the MCP
 * `speak` tool both consume this so a reply lip-syncs *and* emotes in one pass.
 *
 * Every idle/gesture clip this module can ask for MUST exist in
 * public/animations/manifest.json. `referencedClipNames()` enumerates them and
 * tests/embodiment-emotion.test.js asserts the manifest contains each one, so a
 * clip rename can't silently leave a persona reaching for a clip that isn't
 * baked.
 */

/** The emotions the classifier and descriptor table understand. */
export const EMOTIONS = Object.freeze(['neutral', 'joy', 'sad', 'angry', 'surprised', 'thinking']);

/** Above this intensity an emotion escalates from its base gesture to its peak gesture. */
const HIGH_INTENSITY_THRESHOLD = 0.66;

/**
 * Per-emotion descriptor table. `idle` is the loop to rest in; `low` is the
 * gesture for a mild read of the emotion, `high` the escalated one. `face` is
 * the blendshape set at full (intensity = 1) strength — every weight is scaled
 * down linearly by the turn's intensity. All clip names are baked clips in the
 * animation manifest.
 */
const EMOTION_MAP = Object.freeze({
	neutral: {
		idle: 'idle',
		low: null,
		high: null,
		face: {},
	},
	joy: {
		idle: 'idle',
		low: 'av-joy',
		high: 'av-celebrating',
		face: {
			mouthSmileLeft: 0.9,
			mouthSmileRight: 0.9,
			cheekSquintLeft: 0.5,
			cheekSquintRight: 0.5,
			eyeSquintLeft: 0.3,
			eyeSquintRight: 0.3,
		},
	},
	sad: {
		idle: 'xbot-sad-pose',
		low: 'xbot-sad-pose',
		high: 'defeated',
		face: {
			mouthFrownLeft: 0.8,
			mouthFrownRight: 0.8,
			browInnerUp: 0.7,
			eyeLookDownLeft: 0.3,
			eyeLookDownRight: 0.3,
		},
	},
	angry: {
		idle: 'idle',
		low: 'angry',
		high: 'taunt',
		face: {
			browDownLeft: 0.9,
			browDownRight: 0.9,
			noseSneerLeft: 0.5,
			noseSneerRight: 0.5,
			mouthPressLeft: 0.4,
			mouthPressRight: 0.4,
		},
	},
	surprised: {
		idle: 'av-waiting',
		low: 'reaction',
		high: 'jump',
		face: {
			eyeWideLeft: 0.9,
			eyeWideRight: 0.9,
			browInnerUp: 0.6,
			browOuterUpLeft: 0.6,
			browOuterUpRight: 0.6,
		},
	},
	thinking: {
		idle: 'av-leaning-wall',
		low: 'lookdown',
		high: 'facepalm',
		face: {
			browInnerUp: 0.3,
			browDownLeft: 0.3,
			eyeLookUpLeft: 0.4,
			eyeLookUpRight: 0.4,
			mouthPressLeft: 0.3,
		},
	},
});

/**
 * Every ARKit-style blendshape channel any emotion drives, deduped. Derived from
 * the emotion weight sets so it stays in lockstep with them — FaceExpression binds
 * exactly these channels and leaves mouth/viseme morphs to the lip-sync driver.
 */
export const EXPRESSION_CHANNELS = Object.freeze([
	...new Set(Object.values(EMOTION_MAP).flatMap((entry) => Object.keys(entry.face))),
]);

/**
 * Lexical cues per emotion. Single words are matched on word boundaries;
 * multi-word phrases and emoji are matched as substrings. Order is irrelevant —
 * the emotion with the most cue hits wins, neutral on a tie of zero.
 */
const CUES = Object.freeze({
	joy: ['congratulations', 'congrats', 'amazing', 'awesome', 'great', 'wonderful', 'excellent', 'love', 'happy', 'yay', 'fantastic', 'brilliant', '🎉', '🥳', '😄', '😊'],
	sad: ['sorry', 'unfortunately', 'failed', 'sad', 'disappointed', 'regret', 'apologies', 'apologize', 'unable', 'lost', '😢', '😔', '💔'],
	angry: ['unacceptable', 'frustrating', 'frustrated', 'angry', 'furious', 'terrible', 'hate', 'annoyed', 'outrageous', 'ridiculous', 'broken', '😠', '😡'],
	surprised: ['whoa', 'no way', 'incredible', 'unbelievable', 'wow', 'omg', 'shocked', 'really?!', 'surprised', '😮', '😲', '🤯'],
	thinking: ['hmm', 'let me think', 'let me', 'think', 'thinking', 'analyze', 'analyse', 'consider', 'wondering', 'perhaps', 'maybe', 'figure out', '🤔'],
});

const WORD_CHAR = /[a-z0-9]/i;

function countCue(text, cue) {
	// Phrases and emoji can't be word-bounded; match them as substrings.
	if (!WORD_CHAR.test(cue[0]) || !WORD_CHAR.test(cue[cue.length - 1]) || cue.includes(' ')) {
		let count = 0;
		let idx = text.indexOf(cue);
		while (idx !== -1) {
			count += 1;
			idx = text.indexOf(cue, idx + cue.length);
		}
		return count;
	}
	const escaped = cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const matches = text.match(new RegExp(`\\b${escaped}\\b`, 'g'));
	return matches ? matches.length : 0;
}

function clamp01(n) {
	if (Number.isNaN(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

/**
 * Classify the emotion carried by a turn of text.
 *
 * @param {string} text
 * @returns {{ emotion: string, intensity: number, scores: Record<string, number> }}
 */
export function detectEmotion(text) {
	const scores = { neutral: 0, joy: 0, sad: 0, angry: 0, surprised: 0, thinking: 0 };
	const raw = typeof text === 'string' ? text : '';
	const lower = raw.toLowerCase();

	if (!raw.trim()) {
		return { emotion: 'neutral', intensity: 0, scores };
	}

	let topEmotion = 'neutral';
	let topScore = 0;
	for (const emotion of Object.keys(CUES)) {
		let score = 0;
		for (const cue of CUES[emotion]) score += countCue(lower, cue);
		scores[emotion] = score;
		if (score > topScore) {
			topScore = score;
			topEmotion = emotion;
		}
	}

	if (topScore === 0) {
		return { emotion: 'neutral', intensity: 0, scores };
	}

	// Intensity blends how many cues fired with how "loud" the text reads:
	// exclamation marks and the ratio of shouted (uppercase) letters.
	const exclamations = (raw.match(/!/g) || []).length;
	const letters = raw.replace(/[^a-zA-Z]/g, '');
	const uppers = raw.replace(/[^A-Z]/g, '').length;
	const shout = letters.length ? uppers / letters.length : 0;
	const intensity = clamp01(0.35 * topScore + 0.12 * exclamations + 0.35 * shout);

	return { emotion: topEmotion, intensity, scores };
}

/**
 * Build a renderable descriptor for an explicit emotion + intensity. Unknown
 * emotions clamp to neutral. Face weights are scaled by intensity; the gesture
 * escalates from the emotion's base clip to its peak clip past the threshold.
 *
 * @param {string} emotion
 * @param {number} [intensity=0.6]
 * @returns {{ emotion: string, intensity: number, idle: string, gesture: string|null, face: Record<string, number> }}
 */
export function expressionFor(emotion, intensity = 0.6) {
	const key = EMOTION_MAP[emotion] ? emotion : 'neutral';
	const entry = EMOTION_MAP[key];
	const strength = clamp01(intensity);

	const face = {};
	for (const [shape, weight] of Object.entries(entry.face)) {
		face[shape] = weight * strength;
	}

	const escalated = strength >= HIGH_INTENSITY_THRESHOLD;
	const gesture = (escalated ? entry.high : entry.low) || entry.low || entry.high || null;

	return { emotion: key, intensity: strength, idle: entry.idle, gesture, face };
}

/**
 * Classify `text` and thread the result straight into a full descriptor.
 *
 * @param {string} text
 * @returns {{ emotion: string, intensity: number, idle: string, gesture: string|null, face: Record<string, number>, scores: Record<string, number> }}
 */
export function expressionForText(text) {
	const { emotion, intensity, scores } = detectEmotion(text);
	return { ...expressionFor(emotion, intensity), scores };
}

/**
 * Every clip name this module can ask the renderer to play, deduped. The
 * manifest-contract test asserts each one is a baked clip.
 *
 * @returns {string[]}
 */
export function referencedClipNames() {
	const names = new Set();
	for (const entry of Object.values(EMOTION_MAP)) {
		if (entry.idle) names.add(entry.idle);
		if (entry.low) names.add(entry.low);
		if (entry.high) names.add(entry.high);
	}
	return [...names];
}

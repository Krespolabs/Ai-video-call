// Natural-language → pose resolver for the live avatar stage (/agent-screen).
//
// A viewer types or taps a phrase ("wave hello", "warrior stance", "take a
// bow"); this turns it into something the avatar can actually perform:
//   • an animated EMOTE — a real pre-baked clip from the canonical library
//     (public/animations/manifest.json), for prompts that read better as
//     motion than a held pose (wave, dance, celebrate, …), or
//   • a static POSE — a full joint-rotation map from the same preset library
//     the /pose studio renders and the paid `get_pose_seed` MCP tool returns.
//
// The static fallback is deterministic and never dead-ends: the scoring is the
// exact algorithm `get_pose_seed` uses (token overlap, then substring
// containment, then a stable hash-pick), run client-side over the in-repo
// PRESETS so the live stage and the tool resolve the same prompt to the same
// pose — no payment, no network, same library.

import { PRESETS } from './pose-presets.js';

// ── Animated emote intents ────────────────────────────────────────────────────
// Prompts that should play as MOTION. Each maps to a clip that genuinely exists
// in the manifest. `fallbackPreset` is a static preset id used when the clip
// can't be driven on a particular rig (failed load, or the fallen-pose guard
// rejected the retarget) so the avatar still performs *something* — never a
// dead end. Keys are matched against the prompt's lowercased word tokens.
export const EMOTE_INTENTS = [
	{ keys: ['wave', 'hi', 'hello', 'hey', 'greet', 'greeting'], clip: 'wave', label: 'Wave', icon: '👋', fallbackPreset: 'wave' },
	{ keys: ['victory', 'win', 'winner', 'won', 'yay', 'woohoo', 'champion', 'celebrate', 'celebration'], clip: 'celebrate', label: 'Celebrate', icon: '🎉', fallbackPreset: 'hands-up' },
	{ keys: ['cheer', 'cheering', 'hooray', 'hurray'], clip: 'av-cheering', label: 'Cheer', icon: '🙌', fallbackPreset: 'hands-up' },
	{ keys: ['clap', 'claps', 'clapping', 'applause', 'applaud'], clip: 'av-brag-claps', label: 'Clap', icon: '👏', fallbackPreset: 'hands-up' },
	{ keys: ['dance', 'dancing', 'boogie', 'groove', 'party'], clip: 'dance', label: 'Dance', icon: '🕺', fallbackPreset: 'hands-up' },
	{ keys: ['pray', 'prayer', 'praying', 'amen', 'bless'], clip: 'pray', label: 'Pray', icon: '🙏', fallbackPreset: 'praying' },
	{ keys: ['kiss', 'blow', 'mwah', 'love'], clip: 'kiss', label: 'Blow a kiss', icon: '😘', fallbackPreset: 'wave' },
	{ keys: ['taunt', 'tease', 'comeon'], clip: 'taunt', label: 'Taunt', icon: '😏', fallbackPreset: 'point' },
	{ keys: ['jump', 'leap', 'hop', 'bounce'], clip: 'jump', label: 'Jump', icon: '⬆️', fallbackPreset: 'jump' },
	{ keys: ['facepalm', 'ugh', 'disappoint', 'smh'], clip: 'facepalm', label: 'Facepalm', icon: '🤦', fallbackPreset: 'facepalm' },
	{ keys: ['flex', 'muscle', 'muscles', 'strong', 'gains', 'buff'], clip: 'av-arm-flex', label: 'Flex', icon: '💪', fallbackPreset: 'flex' },
];

// ── Static preset matcher (mirrors get_pose_seed) ─────────────────────────────

function tokensOf(s) {
	return String(s || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.filter(Boolean);
}

// Per-preset scoreable vocabulary: id, label words, and group all contribute,
// so "running" hits `run`, "warrior pose" hits `warrior2`, etc. Built once.
const PRESET_INDEX = PRESETS.map((p) => {
	const idTokens = tokensOf(p.id);
	const labelTokens = tokensOf(p.label);
	const groupTokens = tokensOf(p.group);
	return {
		preset: p,
		all: new Set([...idTokens, ...labelTokens, ...groupTokens]),
		idTokens,
		labelTokens,
	};
});

function scorePreset(promptTokens, entry) {
	let score = 0;
	for (const t of promptTokens) {
		if (entry.all.has(t)) {
			score += 3;
		} else {
			// Substring containment in id or label gives partial credit so "wav"
			// hits "wave", "punch" hits "punch (right)".
			for (const tok of [...entry.idTokens, ...entry.labelTokens]) {
				if (tok.includes(t) || t.includes(tok)) {
					score += 1;
					break;
				}
			}
		}
	}
	return score;
}

// FNV-1a over the prompt → a stable index, so an unmatched prompt always maps to
// the same preset for the same caller (the browser-side analogue of the tool's
// sha256 hash-pick — no node:crypto in the bundle).
function hashIndex(prompt, mod) {
	let h = 0x811c9dc5;
	const s = String(prompt);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) % mod;
}

function matchPreset(prompt) {
	const tokens = tokensOf(prompt);
	if (tokens.length === 0) {
		const idx = hashIndex(prompt, PRESETS.length);
		return { entry: PRESET_INDEX[idx], score: 0, reason: 'no-match-deterministic-pick' };
	}
	let best = null;
	let bestScore = -1;
	for (const entry of PRESET_INDEX) {
		const s = scorePreset(tokens, entry);
		if (s > bestScore) {
			best = entry;
			bestScore = s;
		}
	}
	if (bestScore <= 0) {
		const idx = hashIndex(prompt, PRESETS.length);
		return { entry: PRESET_INDEX[idx], score: 0, reason: 'no-match-deterministic-pick' };
	}
	return { entry: best, score: bestScore, reason: 'token-match' };
}

/**
 * Resolve a natural-language prompt to a performable action.
 *
 * @param {string} prompt
 * @returns {{ kind:'clip', clip:string, label:string, icon?:string, fallbackPreset?:string, reason:string }
 *          | { kind:'pose', presetId:string, label:string, parameters:object, icon?:string, score:number, reason:string }}
 */
export function matchPose(prompt) {
	const tokens = tokensOf(prompt);
	for (const intent of EMOTE_INTENTS) {
		if (tokens.some((t) => intent.keys.includes(t))) {
			return {
				kind: 'clip',
				clip: intent.clip,
				label: intent.label,
				icon: intent.icon,
				fallbackPreset: intent.fallbackPreset,
				reason: 'emote-intent',
			};
		}
	}
	const picked = matchPreset(prompt);
	return {
		kind: 'pose',
		presetId: picked.entry.preset.id,
		label: picked.entry.preset.label,
		parameters: picked.entry.preset.pose,
		score: picked.score,
		reason: picked.reason,
	};
}

/** Look up a static preset's joint map by id (for clip fallbacks). */
export function presetPoseById(id) {
	const found = PRESETS.find((p) => p.id === id);
	return found ? found.pose : null;
}

// One-tap quick picks shown under the avatar. Each carries a prompt that runs
// through matchPose(), so a chip behaves exactly like typing the same word.
export const POSE_QUICK_PICKS = [
	{ prompt: 'wave', icon: '👋', label: 'Wave' },
	{ prompt: 'take a bow', icon: '🙇', label: 'Bow' },
	{ prompt: 'victory', icon: '🎉', label: 'Victory' },
	{ prompt: 'flex', icon: '💪', label: 'Flex' },
	{ prompt: 'warrior stance', icon: '🧘', label: 'Warrior' },
	{ prompt: 'point', icon: '👉', label: 'Point' },
	{ prompt: 'pray', icon: '🙏', label: 'Pray' },
	{ prompt: 'dance', icon: '🕺', label: 'Dance' },
];

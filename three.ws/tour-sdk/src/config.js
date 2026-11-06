// Configuration resolution for @three-ws/tour.
// ============================================
// One options object flows from createFeatureTour() to the director and every
// sub-module. Defaults are brand-neutral and degrade gracefully — a tour with no
// options still runs (it fetches /tour/curriculum.json, paces captions to the
// text when no TTS endpoint is wired, and navigates with location.assign). Every
// host-specific concern — where the curriculum lives, how speech is synthesized,
// how pages navigate, what the guide looks like, and the closing copy — is an
// option you override, never a value baked into the engine.

// Built-in narration voices offered in the chapter panel's voice picker. These
// ids match the common OpenAI-compatible TTS voice set; a host whose endpoint
// speaks a different catalogue passes its own `voices`.
export const DEFAULT_VOICES = [
	{ id: 'nova', name: 'Nova' },
	{ id: 'alloy', name: 'Alloy' },
	{ id: 'echo', name: 'Echo' },
	{ id: 'fable', name: 'Fable' },
	{ id: 'onyx', name: 'Onyx' },
	{ id: 'sage', name: 'Sage' },
	{ id: 'shimmer', name: 'Shimmer' },
];

// Neutral closing/recovery copy. Every string is overridable via opts.copy so a
// host can speak in its own voice without touching the engine.
export const DEFAULT_COPY = {
	// Spoken once at the very end, before the completion card appears.
	outro:
		"And that's the tour. Thanks for walking through it with me — explore on your own whenever you're ready.",
	// Spoken when the visitor hand-navigates off the tour route.
	offRoute:
		'We stepped off the tour — press play and I’ll take you back to where we were.',
	completion: {
		title: 'Tour complete 🎉',
		body: "That's the whole tour. Where to next?",
		// Optional primary call-to-action button. Omitted when null.
		primary: null, // e.g. { label: 'Get started', href: '/start' }
		restartLabel: 'Take it again',
		closeLabel: 'Explore on my own',
	},
};

function isObject(v) {
	return v != null && typeof v === 'object';
}

// Deep-ish merge for the copy block only (one level of nesting: completion).
function resolveCopy(opts = {}) {
	const copy = { ...DEFAULT_COPY, ...opts };
	copy.completion = { ...DEFAULT_COPY.completion, ...(opts.completion || {}) };
	return copy;
}

/**
 * Resolve caller options into the fully-defaulted config the engine runs on.
 *
 * @param {object} [opts]
 * @param {string|object} [opts.curriculum]   URL to fetch the curriculum from,
 *        or an already-loaded curriculum object. Default '/tour/curriculum.json'.
 * @param {string|null} [opts.ttsEndpoint]    POST endpoint that turns
 *        `{ text, voice, speed, format }` into an audio response. When null
 *        (the default) narration plays as silent captions paced to the text.
 * @param {string} [opts.defaultVoice]        Default narration voice id.
 * @param {Array<{id,name}>} [opts.voices]    Voice catalogue for the picker.
 * @param {string} [opts.guideAvatarId]       Avatar id the guide loads by default.
 * @param {string} [opts.assetBase]           Base URL for avatar GLB assets.
 * @param {string} [opts.apiBase]             Base URL for the avatar GLB proxy.
 * @param {string} [opts.manifestUrl]         Shared-animation manifest URL.
 * @param {string} [opts.avatarStorageKey]    localStorage key holding the
 *        visitor's chosen avatar (defaults to the @three-ws/walk companion key,
 *        so the guide matches whoever they walk with).
 * @param {(path:string)=>void} [opts.navigate]  How to move to another route.
 * @param {string} [opts.deepLinkParam]       Query param that opens the tour.
 * @param {boolean|object} [opts.companion]   Walk-companion de-dupe integration.
 *        false disables it; an object customises the change-event name.
 * @param {string} [opts.storagePrefix]       Prefix for tour state storage keys.
 * @param {object} [opts.copy]                Override outro / off-route /
 *        completion strings.
 * @returns {object} the resolved config
 */
export function resolveTourConfig(opts = {}) {
	const prefix = opts.storagePrefix || 'tws:tour';
	const companion =
		opts.companion === false
			? null
			: {
					// The global object @three-ws/walk exposes its companion through.
					global: (isObject(opts.companion) && opts.companion.global) || '__walkCompanion',
					// The event it dispatches when it mounts/unmounts.
					changeEvent:
						(isObject(opts.companion) && opts.companion.changeEvent) || 'walk-companion:change',
				};

	return {
		curriculum: opts.curriculum ?? '/tour/curriculum.json',
		ttsEndpoint: opts.ttsEndpoint === undefined ? null : opts.ttsEndpoint,
		defaultVoice: opts.defaultVoice || 'nova',
		voices: Array.isArray(opts.voices) && opts.voices.length ? opts.voices : DEFAULT_VOICES,

		// 'guided' — the avatar walks itself and narrates (default).
		// 'explore' — the visitor drives the avatar (arrows/WASD/joystick) to
		// glowing checkpoints; each one stops it to spotlight and narrate.
		// 'platformer' — explore, but the page's DOM is solid ground: gravity,
		// jumping, falling. Visitors can switch between the two live (M key).
		mode: opts.mode === 'explore' || opts.mode === 'platformer' ? opts.mode : 'guided',
		guideAvatarId: opts.guideAvatarId || 'realistic-female',
		assetBase: opts.assetBase || '',
		apiBase: opts.apiBase || '',
		manifestUrl: opts.manifestUrl || '/animations/manifest.json',
		avatarStorageKey: opts.avatarStorageKey || 'walk:companion:avatar',

		navigate:
			typeof opts.navigate === 'function'
				? opts.navigate
				: (path) => {
						location.assign(path);
					},
		deepLinkParam: opts.deepLinkParam || 'tour',
		companion,

		copy: resolveCopy(opts.copy),

		keys: {
			state: `${prefix}:state`, // live, per-tab tour (sessionStorage)
			resume: `${prefix}:resume`, // durable cross-session memory (localStorage)
		},
	};
}

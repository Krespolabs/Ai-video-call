/**
 * Agent Studio — shared skills catalog
 * ====================================
 * The single source of truth the Studio's Skills and Money tabs read from. Ids
 * are stored verbatim in the agent's `skills[]` array (and matched by the runtime
 * + the create-agent wizard), so these must stay in lock-step with the API's
 * default set and src/create-agent.js.
 *
 * `core` skills are always on (the baseline of a working agent) and cannot be
 * sold individually. `optional` skills are user-toggleable; any of them can be
 * marked sellable and priced in the Money tab. `sellable: false` marks a skill
 * that's behavioral-only (no metered call to charge for).
 */

export const CORE_SKILLS = [
	{ id: 'greet', name: 'Greet', desc: 'Welcomes visitors and opens the conversation.', icon: '👋' },
	{ id: 'present-model', name: 'Present model', desc: 'Shows off and explains its own 3D body.', icon: '🪞' },
	{ id: 'validate-model', name: 'Validate model', desc: 'Checks rig and animation health on load.', icon: '🩺' },
	{ id: 'remember', name: 'Remember', desc: 'Keeps memory across a conversation.', icon: '🧠' },
	{ id: 'think', name: 'Think', desc: 'Reasons step by step before answering.', icon: '✨' },
];

export const OPTIONAL_SKILLS = [
	{ id: 'wave', name: 'Wave', desc: 'Waves at people on greet or on request.', icon: '🙋', sellable: false },
	{ id: 'dance', name: 'Dance', desc: 'Plays a dance animation loop on cue.', icon: '💃', sellable: false },
	{
		id: 'pump-fun',
		name: 'Pump.fun market intel',
		desc: 'Read-only Solana market data: tokens, bonding curves, trending, rug-risk.',
		icon: '📈',
		sellable: true,
	},
	{
		id: 'explain-gltf',
		name: 'Explain glTF',
		desc: 'Narrates mesh, material, and animation info from the scene.',
		icon: '🔍',
		sellable: true,
	},
	{ id: 'web-search', name: 'Web search', desc: 'Looks things up on the live web when asked.', icon: '🌐', sellable: true },
];

export const ALL_SKILLS = [...CORE_SKILLS, ...OPTIONAL_SKILLS];

const BY_ID = new Map(ALL_SKILLS.map((s) => [s.id, s]));

/** Resolve a skill id to its catalog entry, falling back to a derived label. */
export function skillMeta(id) {
	return (
		BY_ID.get(id) || {
			id,
			name: String(id || '')
				.replace(/[-_]/g, ' ')
				.replace(/\b\w/g, (c) => c.toUpperCase()),
			desc: 'Custom skill.',
			icon: '⚙️',
			sellable: true,
		}
	);
}

export const CORE_IDS = new Set(CORE_SKILLS.map((s) => s.id));

/** Whether a skill can be metered + sold (core skills and behavior-only skills can't). */
export function isSellable(id) {
	if (CORE_IDS.has(id)) return false;
	const m = BY_ID.get(id);
	return m ? m.sellable !== false : true;
}

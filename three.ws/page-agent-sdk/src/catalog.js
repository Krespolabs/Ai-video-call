/**
 * Rigged agent catalog — @three-ws/page-agent
 * ============================================
 *
 * Every entry here is a *skeleton-rigged humanoid* glTF agent. This is a hard
 * rule: the page-agent runtime drives skeletal idle motion and mouth/viseme
 * lipsync, so an unrigged mesh would render a frozen, dead-faced statue. We do
 * not ship those. Each avatar in this file has been verified to contain a
 * skinned mesh + armature; the `rig` and `lipsync` fields record *how* it is
 * rigged so the runtime can pick the right mouth driver per avatar:
 *
 *   lipsync: 'viseme'    — Oculus/ARKit viseme morph targets (viseme_aa …).
 *                          Full phoneme-accurate mouth shapes.
 *   lipsync: 'jaw'       — only a jaw/mouthOpen morph. Amplitude-driven open.
 *   lipsync: 'animation' — no face morphs; speech is carried by a talk body
 *                          animation + head motion (Mixamo characters).
 *
 * Assets are served from the three.ws origin (the repo's public/ web root), so
 * the default URLs are real and load with no extra setup. Override `assetBase`
 * (or any entry's `url`) to self-host.
 */

/** Default CDN base. Real, public three.ws assets — `public/avatars/*.glb`. */
export const DEFAULT_ASSET_BASE = 'https://three.ws/avatars/';

/**
 * @typedef {Object} RiggedAgent
 * @property {string}  id        Stable slug used in attributes / localStorage.
 * @property {string}  name      Display name shown in the picker + caption.
 * @property {string}  tagline   One-line personality hook for the picker card.
 * @property {string}  persona   Short voice/identity blurb (also the default
 *                               greeting flavor). Plain language — no jargon.
 * @property {string}  file      GLB filename under the asset base.
 * @property {string} [url]      Absolute override; wins over assetBase+file.
 * @property {'rpm'|'mixamo'|'studio'} rig   Rig family.
 * @property {'viseme'|'jaw'|'animation'} lipsync  Mouth driver to use.
 * @property {'female'|'male'|'neutral'|'robot'} presents  Voice/picker hint.
 * @property {'realistic'|'stylized'|'robot'} style
 * @property {'bust'|'upper'|'full'} framing  Default camera crop.
 * @property {{ lang?: string, pitch?: number, rate?: number, match?: string[] }} voice
 *           Web Speech selection hints — `match` are case-insensitive
 *           substrings tried against installed voice names, in order.
 * @property {string}  accent    Accent color for this agent's UI chrome.
 */

/** @type {RiggedAgent[]} */
export const AGENTS = [
	{
		id: 'sol',
		name: 'Sol',
		tagline: 'Calm, clear product guide',
		persona: "I'm Sol — I walk you through a page like a good colleague would: the what, the why, and where to click next.",
		file: 'realistic-halfbody.glb',
		rig: 'rpm',
		lipsync: 'viseme',
		presents: 'neutral',
		style: 'realistic',
		framing: 'bust',
		voice: { lang: 'en-US', pitch: 1.0, rate: 1.0, match: ['samantha', 'jenny', 'aria', 'google us english'] },
		accent: '#6366f1',
	},
	{
		id: 'nova',
		name: 'Nova',
		tagline: 'Upbeat, friendly host',
		persona: "Hey, I'm Nova! I keep things light and quick — ask me anything and I'll show you around.",
		file: 'selfie-girl.glb',
		rig: 'rpm',
		lipsync: 'viseme',
		presents: 'female',
		style: 'stylized',
		framing: 'upper',
		voice: { lang: 'en-US', pitch: 1.12, rate: 1.04, match: ['jenny', 'aria', 'samantha', 'google us english'] },
		accent: '#ec4899',
	},
	{
		id: 'vera',
		name: 'Vera',
		tagline: 'Composed, professional',
		persona: "I'm Vera. Precise and to the point — I'll give you the signal, not the noise.",
		file: 'realistic-female.glb',
		rig: 'rpm',
		lipsync: 'viseme',
		presents: 'female',
		style: 'realistic',
		framing: 'bust',
		voice: { lang: 'en-GB', pitch: 1.0, rate: 0.98, match: ['libby', 'sonia', 'google uk english female', 'serena'] },
		accent: '#14b8a6',
	},
	{
		id: 'atlas',
		name: 'Atlas',
		tagline: 'Confident, grounded',
		persona: "Atlas here. I'll break down what matters and keep you moving — no fluff.",
		file: 'realistic-male.glb',
		rig: 'rpm',
		lipsync: 'viseme',
		presents: 'male',
		style: 'realistic',
		framing: 'bust',
		voice: { lang: 'en-US', pitch: 0.92, rate: 0.98, match: ['guy', 'eric', 'google us english', 'daniel'] },
		accent: '#3b82f6',
	},
	{
		id: 'echo',
		name: 'Echo',
		tagline: 'Neutral, even-keeled',
		persona: "I'm Echo — a steady, no-nonsense guide. Tell me where you want to go.",
		file: 'default.glb',
		rig: 'rpm',
		lipsync: 'viseme',
		presents: 'neutral',
		style: 'stylized',
		framing: 'upper',
		voice: { lang: 'en-US', pitch: 1.0, rate: 1.0, match: ['google us english', 'samantha', 'guy'] },
		accent: '#8b5cf6',
	},
	{
		id: 'lumen',
		name: 'Lumen',
		tagline: 'Minimal studio presenter',
		persona: "Lumen. Clean and quiet — I narrate, you explore.",
		file: 'studio.glb',
		rig: 'studio',
		lipsync: 'jaw',
		presents: 'neutral',
		style: 'stylized',
		framing: 'upper',
		voice: { lang: 'en-US', pitch: 1.0, rate: 1.0, match: ['google us english', 'samantha'] },
		accent: '#0ea5e9',
	},
	{
		id: 'kai',
		name: 'Kai',
		tagline: 'Playful robot sidekick',
		persona: "Beep — Kai online. I'm the robot in the corner who actually read the docs.",
		file: 'xbot.glb',
		rig: 'mixamo',
		lipsync: 'animation',
		presents: 'robot',
		style: 'robot',
		framing: 'full',
		voice: { lang: 'en-US', pitch: 0.85, rate: 1.05, match: ['guy', 'google us english', 'fred'] },
		accent: '#f59e0b',
	},
	{
		id: 'mira',
		name: 'Mira',
		tagline: 'Expressive, full-body',
		persona: "I'm Mira — I talk with my whole self. Great energy for a tour.",
		file: 'michelle.glb',
		rig: 'mixamo',
		lipsync: 'animation',
		presents: 'female',
		style: 'stylized',
		framing: 'full',
		voice: { lang: 'en-US', pitch: 1.08, rate: 1.0, match: ['aria', 'jenny', 'samantha'] },
		accent: '#ef4444',
	},
	{
		id: 'pax',
		name: 'Pax',
		tagline: 'Laid-back explainer',
		persona: "Pax. I keep it relaxed and human — we'll get through this together.",
		file: 'cz.glb',
		rig: 'mixamo',
		lipsync: 'animation',
		presents: 'neutral',
		style: 'stylized',
		framing: 'full',
		voice: { lang: 'en-US', pitch: 0.96, rate: 0.97, match: ['google us english', 'guy', 'samantha'] },
		accent: '#22c55e',
	},
];

/** Default agent shown before any visitor choice is restored. */
export const DEFAULT_AGENT_ID = 'sol';

const _byId = new Map(AGENTS.map((a) => [a.id, a]));

/** @param {string} id @returns {RiggedAgent|undefined} */
export function getAgent(id) {
	return _byId.get(id);
}

/**
 * Resolve an agent's absolute GLB URL.
 * @param {RiggedAgent} agent
 * @param {string} [assetBase]
 * @returns {string}
 */
export function agentUrl(agent, assetBase = DEFAULT_ASSET_BASE) {
	if (agent.url) return agent.url;
	const base = assetBase.endsWith('/') ? assetBase : assetBase + '/';
	return base + agent.file;
}

/**
 * Filtered view of the catalog. Every agent is rigged by construction; these
 * filters narrow by presentation/style/lipsync capability for a host that
 * wants a curated subset in the picker.
 *
 * @param {{ style?: string, presents?: string, lipsync?: string, ids?: string[] }} [q]
 * @returns {RiggedAgent[]}
 */
export function filterAgents(q = {}) {
	let list = AGENTS;
	if (q.ids?.length) {
		const want = new Set(q.ids);
		list = list.filter((a) => want.has(a.id));
	}
	if (q.style) list = list.filter((a) => a.style === q.style);
	if (q.presents) list = list.filter((a) => a.presents === q.presents);
	if (q.lipsync) list = list.filter((a) => a.lipsync === q.lipsync);
	return list;
}

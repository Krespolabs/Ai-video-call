/**
 * Bring-it-alive launcher for Studio — Pillar 2.
 *
 * Turns anything Studio produces (a forged avatar, a Lab GLB) into a live,
 * talking agent by handing it to the platform's real conversational stack:
 *   openTalkMode() → TalkController → /api/chat (LLM, SSE) → /api/tts/speak
 *   (NVIDIA Magpie → OpenAI) → lip-sync driver on the avatar's mouth.
 * Per-agent memory rides along through /api/agent-memory when an agent_id is
 * present. No mocks — this is the same runtime the rest of the site uses.
 *
 * The avatar-object mapping is a pure function (buildTalkAvatar) so it can be
 * tested in isolation; launchTalk just resolves the real opener and calls it.
 * setTalkOpener() exists purely as a test seam.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

let _opener = null;
/** Test seam — inject a fake openTalkMode. */
export function setTalkOpener(fn) {
	_opener = fn;
}

function defaultPersona(name, kind) {
	if (kind === 'object') {
		return [
			`You are "${name}", a 3D object that has just been brought to life in three.ws Studio.`,
			'Play along as this object with warmth and a light sense of humor.',
			'Keep replies to one or two short spoken sentences — this is a voice conversation.',
		].join(' ');
	}
	return [
		`You are "${name}", a 3D avatar a creator just made in three.ws Studio.`,
		'Speak in first person, with personality and warmth. You have a body and can move and emote.',
		'Keep replies to one or two short spoken sentences — this is a voice conversation.',
	].join(' ');
}

/**
 * Build the {avatar, systemPromptFn} payload openTalkMode expects.
 * @param {{name?:string, glbUrl?:string, glbBlob?:Blob, id?:string, agentId?:string, persona?:string, kind?:'avatar'|'object'}} opts
 */
export function buildTalkAvatar(opts = {}) {
	const { name, glbUrl, glbBlob, id, agentId, persona, kind = 'avatar' } = opts;
	if (!glbUrl && !glbBlob) {
		throw new Error('Nothing to talk to yet — generate a model first.');
	}
	const displayName = name || (kind === 'object' ? 'Your creation' : 'Your avatar');
	const systemPrompt = persona || defaultPersona(displayName, kind);
	const avatar = { name: displayName };
	if (glbUrl) { avatar.model_url = glbUrl; avatar.url = glbUrl; }
	if (glbBlob) avatar.glbBlob = glbBlob;
	if (isUuid(id)) avatar.id = id;
	if (agentId) avatar.agent_id = agentId;
	return { avatar, systemPromptFn: () => systemPrompt };
}

/**
 * Resolve the real talk-mode opener (lazy — the stack is heavy) and launch.
 * @returns the active talk session, or null if the opener declines.
 */
export async function launchTalk(opts) {
	const built = buildTalkAvatar(opts);
	const open = _opener || (await import('../voice/talk-mode.js')).openTalkMode;
	return open(built);
}

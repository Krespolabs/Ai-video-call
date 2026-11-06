/**
 * Agent-manifest/0.2 bundle builder (browser).
 * ---------------------------------------------
 * Assembles the rich, Claude-shaped agent manifest (specs/AGENT_MANIFEST.md)
 * from an agent's already-stored data — body GLB, system prompt, voice config,
 * installed skills, memory mode, scene-tools, and on-chain identity — pins it,
 * and returns its resolvable URI. The ERC-8004 registration card points at this
 * URI via its `manifest` field, so an on-chain agent carries its full runtime
 * configuration, not just a body + thumbnail.
 *
 * Asset reuse is deliberate:
 *   - the body GLB is referenced by its existing public URL (already content
 *     hosted) — never re-pinned;
 *   - installed skills are referenced by their canonical registry URIs
 *     (https://three.ws/skills/<id>/ or the absolute URI in skills-index.json) —
 *     already hosted, so re-pinning identical bytes would be waste;
 *   - only genuinely new bytes are pinned: instructions.md (built from the
 *     agent's private system prompt) and manifest.json itself.
 *
 * Memory is intentionally NOT pinned: an agent's memory is owner-private and
 * lives behind the authenticated /api/agent-memory backend, so the manifest
 * declares `memory.mode = "remote"` rather than leaking memory contents into a
 * public, content-addressed bundle.
 */

// Built-in scene-tools every embodied agent has without installing a skill.
const DEFAULT_TOOLS = ['wave', 'lookAt', 'play_clip', 'setExpression', 'speak', 'remember'];

// Local skill ids that map to built-in scene-tools rather than installable
// skill bundles — these become `tools`, not `skills`, entries.
const BUILTIN_SKILL_TOOLS = new Set([
	'greet',
	'present-model',
	'validate-model',
	'remember',
	'think',
	'wave',
	'lookAt',
	'pointAt',
	'play_clip',
	'setExpression',
	'moveTo',
	'speak',
]);

// chainId → agent:// alias understood by src/manifest.js CHAIN_ALIASES. Falls
// back to the numeric id (still resolvable: loadFromAgentURI coerces with Number).
const CHAIN_ALIAS = {
	1: 'ethereum',
	8453: 'base',
	84532: 'base-sepolia',
};

/**
 * Build the instructions.md document from the agent's persona.
 * Uses the owner-only system prompt when present (the GET /api/agents/:id
 * response includes it for the owner), else falls back to the description.
 */
function buildInstructionsMarkdown(agent) {
	const name = agent.name || 'Agent';
	const body =
		(agent.system_prompt && agent.system_prompt.trim()) ||
		(agent.description && agent.description.trim()) ||
		`You are ${name}, a 3D AI agent on three.ws. You are friendly and conversational. ` +
			`You can wave, play animations, and change expressions using your scene-tools. ` +
			`When greeting someone, use the wave tool.`;
	const frontmatter = `---\nname: ${name}\nmodel: claude-opus-4-8\ntemperature: 0.7\n---\n\n`;
	return frontmatter + body + '\n';
}

/**
 * Resolve the agent's installed skill names into manifest skill entries and the
 * scene-tool list. Unknown skills are surfaced as warnings — never silently
 * dropped — so a partial manifest is always visible to the caller.
 *
 * @returns {Promise<{ skills: Array<{uri:string,version?:string}>, tools: string[], warnings: string[] }>}
 */
async function resolveSkills(agent, origin) {
	const warnings = [];
	const tools = new Set(DEFAULT_TOOLS);
	const skills = [];
	const names = Array.isArray(agent.skills) ? agent.skills : [];
	if (names.length === 0) return { skills, tools: [...tools], warnings };

	let registry = [];
	try {
		const res = await fetch(`${origin}/skills-index.json`, { cache: 'no-cache' });
		if (res.ok) registry = await res.json();
	} catch {
		/* registry unreachable — handled per-skill below */
	}
	const byId = new Map((Array.isArray(registry) ? registry : []).map((s) => [s.id, s]));

	for (const name of names) {
		const entry = byId.get(name);
		if (entry) {
			// Relative uris (e.g. "skills/wave/") are served statically from our own
			// origin — turn them into absolute, resolvable HTTPS skill URIs.
			const uri = /^([a-z]+:)?\/\//i.test(entry.uri)
				? entry.uri
				: `${origin}/${String(entry.uri).replace(/^\/+/, '')}`;
			skills.push({ uri, version: entry.version || '0.1.0' });
		} else if (BUILTIN_SKILL_TOOLS.has(name)) {
			tools.add(name);
		} else {
			warnings.push(`Skill "${name}" is not in the skill registry and was omitted from the manifest.`);
		}
	}

	return { skills, tools: [...tools], warnings };
}

/**
 * Build, pin, and return the agent-manifest/0.2 bundle for an agent.
 *
 * @param {object} agent  Full agent record from GET /api/agents/:id (owner view).
 * @param {object} opts
 * @param {string|null} [opts.glbUrl]    Public GLB URL to reuse as the body (no re-pin).
 * @param {string|null} [opts.imageUrl]  Public thumbnail URL for poster/image.
 * @param {{ chainId:number, agentId:number|string, registry:string, owner:string }} [opts.onchain]
 *   On-chain identity to stamp into `manifest.id` (known after the mint).
 * @param {(blob: Blob) => Promise<string>} opts.pinFile  Pinning function (injected to avoid a cyclic import).
 * @param {(msg: string) => void} [opts.onStatus]
 * @returns {Promise<{ uri: string, manifest: object, warnings: string[] }>}
 */
export async function buildAgentManifest(agent, { glbUrl, imageUrl, onchain, pinFile, onStatus } = {}) {
	if (typeof pinFile !== 'function') {
		throw new Error('buildAgentManifest requires a pinFile function.');
	}
	const log = onStatus || (() => {});
	const origin = typeof location !== 'undefined' ? location.origin : 'https://three.ws';

	// instructions.md — genuinely new bytes, so pin it. The pin endpoint's
	// allow-list has no text/markdown entry; octet-stream is the honest carrier
	// for arbitrary text and resolves back as markdown via res.text().
	log('Building instructions…');
	const instructions = buildInstructionsMarkdown(agent);
	const instructionsUri = await pinFile(
		new Blob([instructions], { type: 'application/octet-stream' }),
	);

	log('Resolving skills…');
	const { skills, tools, warnings } = await resolveSkills(agent, origin);

	const bodyUri = glbUrl || imageUrl || '';
	const nowIso = new Date().toISOString();

	const manifest = {
		$schema: 'https://3d-agent.io/schemas/manifest/0.2.json',
		spec: 'agent-manifest/0.2',
		...(onchain
			? {
					id: {
						chain: CHAIN_ALIAS[onchain.chainId] || String(onchain.chainId),
						registry: onchain.registry,
						agentId: String(onchain.agentId),
						owner: onchain.owner,
					},
				}
			: {}),
		name: agent.name || 'Agent',
		description: agent.description || '',
		...(imageUrl ? { image: imageUrl } : {}),
		tags: ['three.ws', 'ai-agent', ...(Array.isArray(agent.skills) ? agent.skills : [])],
		body: { uri: bodyUri, format: 'gltf-binary' },
		brain: {
			provider: 'anthropic',
			model: 'claude-opus-4-8',
			instructions: instructionsUri,
			temperature: 0.7,
			thinking: 'auto',
		},
		voice: {
			tts: {
				provider: agent.voice_provider || 'browser',
				voiceId: agent.voice_id || 'default',
				...(agent.voice_model ? { model: agent.voice_model } : {}),
				...(agent.voice_settings && typeof agent.voice_settings === 'object'
					? agent.voice_settings
					: {}),
			},
			stt: { provider: 'browser', language: 'en-US', continuous: false },
		},
		skills,
		// Owner-private memory stays behind the authenticated backend — never pinned.
		memory: { mode: 'remote', maxTokens: 8192 },
		tools,
		...(agent.meta && agent.meta.permissions ? { permissions: agent.meta.permissions } : {}),
		created: agent.created_at || nowIso,
		updated: nowIso,
		version: '0.2.0',
	};

	log('Pinning manifest…');
	const uri = await pinFile(
		new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
	);

	return { uri, manifest, warnings };
}

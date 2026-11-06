// One conversational turn with an agent, server-side.
//
// Shared by POST /api/agents/talk (the authenticated, MCP-delegate surface) and
// POST /api/x402/agents/:id (the agent sold as a paid x402 API). Both build the
// same system prompt from the agent's own record: its brain instructions, the
// prompt-only custom skills its owner installed, patronage context for the
// caller's wallet, and which premium skills THIS caller has unlocked. Keeping
// that in one place means a buyer of the paid API talks to exactly the agent
// the owner configured, not a drifted copy of it.

import { sql } from './db.js';
import { normalizeLegacyPolicy } from './embed-policy.js';
import { llmComplete, LlmUnavailableError } from './llm.js';
import { hasSkillAccess } from './skill-access.js';
import { patronChatContext, patronStanding, listPerks, entitledPerks } from './patronage.js';
import { agentSkillsForPrompt } from './agent-custom-skills.js';

export const ALLOWED_MODELS = new Set([
	'claude-haiku-4-5-20251001',
	'claude-sonnet-4-5',
	'claude-sonnet-4-6',
	'claude-sonnet-5',
	'claude-opus-4-7',
	'claude-opus-5',
]);

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Build the agent's skill_ownership context for one requesting user. Every skill
// the agent declares is classified as premium (priced + active in
// agent_skill_prices) or free; for premium skills we resolve the caller's real
// access via hasSkillAccess (purchase / subscription / trial). Anonymous callers
// (userId === null) own no premium skill. Returns a compact, structured prompt
// section, or null when the agent has no skills worth describing.
export async function buildSkillOwnershipBlock(agent, userId, patronSkills = new Set()) {
	const skills = Array.isArray(agent.skills) ? agent.skills.filter(Boolean) : [];
	if (skills.length === 0) return null;

	// One query for all of this agent's active prices, then classify in memory,
	// avoiding a per-skill price lookup. hasSkillAccess re-checks the price row,
	// but only for skills we already know are premium.
	const priceRows = await sql`
		SELECT skill FROM agent_skill_prices
		WHERE agent_id = ${agent.id} AND is_active = true
	`;
	const pricedSkills = new Set(priceRows.map((r) => r.skill));

	const ownership = {};
	for (const skill of skills) {
		if (!pricedSkills.has(skill)) {
			ownership[skill] = { is_premium: false, is_owned: true };
			continue;
		}
		// A patron whose verified on-chain support clears a skill-perk threshold uses
		// that premium skill for free, the same gate the Support surface advertises.
		if (patronSkills.has(skill)) {
			ownership[skill] = { is_premium: true, is_owned: true, via_patron: true };
			continue;
		}
		if (!userId) {
			ownership[skill] = { is_premium: true, is_owned: false };
			continue;
		}
		const access = await hasSkillAccess(userId, agent.id, skill);
		ownership[skill] = { is_premium: true, is_owned: Boolean(access.owned) };
	}

	const hasPremium = Object.values(ownership).some((o) => o.is_premium);
	if (!hasPremium) return null; // nothing to monetize, keep the prompt lean.

	return [
		'## Skill access (current user)',
		'The JSON below maps each of your skills to whether it is premium (paid) and whether THIS user has already unlocked it:',
		JSON.stringify(ownership),
		'Behaviour rules:',
		'- Use any skill where is_owned is true freely, without mentioning payment.',
		'- If the user asks to use a skill where is_premium is true and is_owned is false, do NOT perform it. Politely explain it is a paid skill and invite them to unlock it from your agent profile page, then offer the free skills you can do instead.',
		"- Never invent prices, never reveal another user's access, and never claim a skill is unlocked when is_owned is false.",
	].join('\n');
}

/**
 * The model a turn runs on: a requested model only when it is on the allowlist,
 * otherwise the agent's own brain model.
 */
export function resolveTurnModel(agent, requestedModel = null) {
	const policy = normalizeLegacyPolicy(agent.embed_policy);
	const defaultModel = policy?.brain?.model || DEFAULT_MODEL;
	return requestedModel && ALLOWED_MODELS.has(requestedModel) ? requestedModel : defaultModel;
}

/**
 * The full system prompt for one caller. `callerWallet` drives patronage (the
 * caller's standing is derived from chain truth for that wallet); `userId`
 * drives premium-skill ownership. Both are optional: an anonymous caller gets
 * the agent's persona with no unlocked premium skills.
 */
export async function buildAgentSystemPrompt(agent, { userId = null, callerWallet = null } = {}) {
	const basePrompt =
		agent.meta?.brain?.instructions || `You are ${agent.name}. ${agent.description || ''}`.trim();

	const patronSkills = new Set();
	if (callerWallet) {
		try {
			const [standing, perks] = await Promise.all([
				patronStanding(agent.id, callerWallet),
				listPerks(agent.id, { activeOnly: true }),
			]);
			for (const p of entitledPerks(perks, standing.usd)) {
				if (p.perkType === 'skill' && p.payload?.skill) patronSkills.add(p.payload.skill);
			}
		} catch (err) {
			// Patronage is enrichment: a lookup failure never blocks the reply.
			console.warn('[agent-turn] patron standing unavailable', err?.message || err);
		}
	}
	const patronBlock = callerWallet
		? await patronChatContext(agent.id, callerWallet).catch(() => null)
		: null;

	const ownershipBlock = await buildSkillOwnershipBlock(agent, userId, patronSkills);
	// The agent's own prompt-only custom skills (api/_lib/agent-custom-skills.js):
	// same install order and budget as /api/chat. Enrichment, never a failed reply.
	const { block: agentSkillsBlock } = await agentSkillsForPrompt(agent.id).catch(() => ({ block: '' }));
	return [basePrompt, agentSkillsBlock, patronBlock, ownershipBlock].filter(Boolean).join('\n\n');
}

// Prior turns are folded into the user message as a transcript: the LLM chain
// behind llmComplete is single-turn (system + user) across every provider rung,
// so this is the one shape every rung understands.
export function composeUserMessage(message, history = []) {
	if (!Array.isArray(history) || history.length === 0) return message;
	const lines = history.map((h) => `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${h.content}`);
	return [
		'Conversation so far:',
		...lines,
		'',
		"Reply to the user's latest message:",
		message,
	].join('\n');
}

/** A turn that could not produce a reply. `status` / `code` map to the HTTP answer. */
export class AgentTurnError extends Error {
	constructor(status, code, message) {
		super(message);
		this.name = 'AgentTurnError';
		this.status = status;
		this.code = code;
	}
}

/**
 * Run one turn. Resolves `{ text, model, usage }`; rejects with AgentTurnError
 * (503 llm_unavailable when every provider rung is down, 502 upstream_error on
 * any other LLM failure). Nothing here charges anyone: a paid caller settles
 * only after this resolves.
 */
export async function runAgentTurn({
	agent,
	message,
	history = [],
	userId = null,
	callerWallet = null,
	requestedModel = null,
	tool = 'agent.talk',
	maxTokens = 1024,
}) {
	const model = resolveTurnModel(agent, requestedModel);
	const system = await buildAgentSystemPrompt(agent, { userId, callerWallet });
	try {
		const result = await llmComplete({
			system,
			user: composeUserMessage(message, history),
			maxTokens,
			// Free providers serve first; if every one fails, the paid backstop uses
			// the agent's chosen Claude model on the platform key.
			anthropicModel: model,
			track: { agentId: agent.id, tool },
		});
		return { text: result.text, model: result.model, usage: result.usage ?? null };
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			throw new AgentTurnError(503, 'llm_unavailable', 'the agent cannot answer right now, every model provider is unavailable');
		}
		throw new AgentTurnError(502, 'upstream_error', `LLM call failed: ${err.message}`);
	}
}

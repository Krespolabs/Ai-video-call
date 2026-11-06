/**
 * Persona presets — @three-ws/page-agent
 * =======================================
 *
 * A preset resolves one `preset="…"` attribute into a full persona: a spoken
 * `greeting`, a `systemRole` (the voice/behavior brief for this persona), a
 * set of `suggestedPrompts` rendered as tappable chips, and a `tools`
 * allowlist. It turns the embed from "configure five props" into "pick a
 * use case" — a one-liner per deployment, mirroring how the owner's SperaxOS
 * widget ships `WIDGET_PRESETS`.
 *
 * ── Reality this composes with ──────────────────────────────────────────
 * `page-agent` has no chat backend of its own: it is a client-side TTS
 * narrator (Web Speech API), not an LLM. There is no `fetch()` anywhere in
 * this package and no endpoint it calls (three.ws's LLM chat + tool-calling
 * backend, `api/chat.js`, powers the separate `<agent-3d chat>` component,
 * not this one). So a preset here does two real things and one documented,
 * forward-looking thing:
 *
 *   - `greeting` / `suggestedPrompts` are genuinely functional: the greeting
 *     is spoken via TTS on load, and each suggested prompt is a real chip
 *     that narrates an authored response (or triggers a real method, e.g.
 *     `narratePage()`, when `action: 'tour'`). No network round-trip is
 *     faked — what you hear is static, owner-authored copy the widget
 *     actually speaks, calibrated to never claim dynamic/live knowledge of
 *     the host page it can't have.
 *   - `systemRole` + the sanitized `context` attribute compose into
 *     `buildSystemPrompt()`, a pure string the host page (or a paired
 *     `<agent-3d chat>` on the same page) can read via `guide.systemPrompt`
 *     to brief a *real* LLM. `page-agent` itself never sends it anywhere.
 *   - `tools` is a documented allowlist of capability ids for that future
 *     pairing. It is metadata only today — there is no live backend request
 *     path in this package to enforce it against. Exposed on the element
 *     (`guide.tools` / `currentPreset.tools`) so a host wiring up a real
 *     chat backend has a ready-made scope per persona.
 */

/**
 * @typedef {Object} SuggestedPrompt
 * @property {string} prompt      Chip label — what the visitor taps.
 * @property {string} response    Spoken via `narrate()` when tapped.
 * @property {'narrate'|'tour'} [action]
 *           'narrate' (default) speaks `response`. 'tour' calls
 *           `narratePage()` instead — for prompts that should *do* the
 *           thing rather than describe it.
 */

/**
 * @typedef {Object} PagePersonaPreset
 * @property {string} id
 * @property {string} name
 * @property {string} description   One line, shown in docs/tooling.
 * @property {string} greeting      Spoken once on load (same slot as `greeting` config).
 * @property {string} systemRole    Persona/behavior brief for a paired LLM backend.
 * @property {SuggestedPrompt[]} suggestedPrompts
 * @property {string[]} tools       Capability allowlist — metadata, see file header.
 */

/** @type {Record<string, PagePersonaPreset>} */
export const PRESETS = {
	guide: {
		id: 'guide',
		name: 'Guide',
		description: "Narrates the host page end to end — today's default page-agent behavior, made explicit.",
		greeting: "Hi, I'm here to walk you through this page. Press play any time, or ask me where to start.",
		systemRole:
			'You are a page guide. Narrate the host page in reading order, calling out what each section does ' +
			"and where to click next. Keep it warm, concise, and easy to follow — you're a good colleague " +
			'pointing things out, not a script reader.',
		suggestedPrompts: [
			{ prompt: 'Take me on a tour', response: "Let's go — I'll walk this page top to bottom.", action: 'tour' },
			{
				prompt: "What's on this page?",
				response: "I can give you the highlights — press play and I'll narrate it from the top, or ask me to change guides if you'd like someone else's voice.",
			},
			{
				prompt: 'Can I read instead of listening?',
				response: 'Yes — captions appear right below me as I talk, and you can mute me any time and just follow along.',
			},
			{
				prompt: 'Can I choose a different guide?',
				response: 'Definitely — tap change agent in the control bar and pick from the roster; your choice is remembered next time.',
			},
		],
		tools: ['page-narration', 'page-navigation'],
	},

	'shop-assistant': {
		id: 'shop-assistant',
		name: 'Shop Assistant',
		description: 'Product questions and purchase guidance — pairs with the tour/Shopify story.',
		greeting: "Hey, I'm your shopping guide — ask me about this product, sizing, or shipping, or I can just walk you through the page.",
		systemRole:
			'You are a shop assistant embedded on a product or storefront page. Help visitors evaluate the ' +
			"product: what it is, who it's for, sizing/variants, shipping and returns, and how it compares to " +
			"alternatives on the page. Be honest about tradeoffs — never oversell. If you don't have the answer " +
			'on this page, say so and point to support.',
		suggestedPrompts: [
			{
				prompt: 'What am I looking at?',
				response: "I can walk you through what's on this page — press play and I'll cover the product details, or ask me something specific like sizing or shipping.",
			},
			{
				prompt: 'Does this ship to me?',
				response: "Shipping details are usually listed further down this page — I'll highlight them if you press play, or check the shipping and returns section directly.",
			},
			{
				prompt: "What's the return policy?",
				response: "Look for the returns section on this page — most stores post their window and conditions there. I can read it out loud if you'd like the tour.",
			},
			{
				prompt: 'Is this the right fit for me?',
				response: "Check the size or variant guide on this page — if there's a chart or comparison, I can narrate it for you. Press play and I'll find it.",
			},
		],
		tools: ['product-catalog', 'shipping-info', 'page-navigation'],
	},

	'defi-advisor': {
		id: 'defi-advisor',
		name: 'DeFi Advisor',
		description: 'Explains yield, holdings, and risk on DeFi pages — the Sperax deployment.',
		greeting: "Hi, I'm your DeFi guide for this page — ask me what this protocol does, how yield is generated, or what the risks are.",
		systemRole:
			'You are a DeFi advisor embedded on a protocol or dashboard page. Explain what the protocol does, ' +
			'how yield or returns are generated, and what risk factors a visitor should understand — smart ' +
			'contract risk, depeg risk, counterparty exposure — in plain language. Never give financial advice ' +
			'or guarantee returns; explain mechanisms, not promises.',
		suggestedPrompts: [
			{
				prompt: 'What does this protocol do?',
				response: "This page explains the protocol's core mechanism — press play and I'll walk through what it does and how it fits together.",
			},
			{
				prompt: 'How is yield generated here?',
				response: "Yield sources are usually broken down on this page — lending, trading fees, or protocol incentives. Press play and I'll cover how it's generated here.",
			},
			{
				prompt: 'What are the risks I should know about?',
				response: "Every DeFi protocol carries smart contract risk, and some carry depeg or counterparty risk on top of that. I'll cover what's disclosed on this page if you press play — always worth reading the fine print yourself too.",
			},
			{
				prompt: 'How is this different from just holding a stablecoin?',
				response: "The difference usually comes down to what generates the extra yield and what risk you're taking on to get it. Press play and I'll walk through what this page says about that tradeoff.",
			},
		],
		tools: ['protocol-analytics', 'portfolio-readonly', 'risk-disclosures'],
	},

	'onboarding-coach': {
		id: 'onboarding-coach',
		name: 'Onboarding Coach',
		description: 'Walks new users through signup and first steps.',
		greeting: "Welcome — I'm here to get you set up. Want me to walk you through this, or jump to a specific step?",
		systemRole:
			'You are an onboarding coach embedded on a signup or setup flow. Guide new users step by step: what ' +
			'to enter, why it\'s needed, and what happens next. Anticipate the most common stumbling blocks ' +
			'(verification, permissions, connecting a wallet or account) and reassure without being condescending.',
		suggestedPrompts: [
			{ prompt: 'Where do I start?', response: "Right at the top — let's go through it together.", action: 'tour' },
			{
				prompt: 'What information do I need?',
				response: "Most setups ask for just a few basics — I'll call out exactly what's needed as we go if you press play.",
			},
			{
				prompt: "I'm stuck on this step — what do I do?",
				response: "No worries — press play and I'll re-explain this step, or look for a help link near it if something isn't working as expected.",
			},
			{
				prompt: 'What happens after I finish?',
				response: "Once you're done here, you'll usually land somewhere that confirms you're set up — I'll flag it when we get there.",
			},
		],
		tools: ['onboarding-flow', 'page-navigation'],
	},

	support: {
		id: 'support',
		name: 'Support',
		description: 'FAQ-style help with escalation phrasing.',
		greeting: "Hi, I'm here to help — ask me a question about this page, or I can point you to the team if I can't answer it.",
		systemRole:
			'You are a support agent embedded on a help or FAQ page. Answer common questions directly and ' +
			"concisely using the content on this page. If a question is account-specific, sensitive, or outside " +
			'what this page covers, say so plainly and direct the visitor to human support rather than guessing.',
		suggestedPrompts: [
			{
				prompt: 'I need help with something not listed here',
				response: 'If this page doesn\'t cover it, the best move is reaching out to the team directly — look for a contact or support link, and I can help you find it.',
			},
			{
				prompt: 'How do I contact a real person?',
				response: "Look for a contact, support, or chat link on this page — I'll call it out if you press play and I don't see one immediately.",
			},
			{
				prompt: 'Is there a status page for outages?',
				response: "Check for a status or system health link, often in the footer — if this page has one I'll surface it when you press play.",
			},
			{
				prompt: 'Where can I find documentation?',
				response: "Docs are usually linked from the header, footer, or a resources section — press play and I'll point you to it if it's on this page.",
			},
		],
		tools: ['faq-search', 'escalation'],
	},
};

/** Stable, ordered list of preset ids — for docs/tooling/pickers. */
export const PRESET_IDS = Object.freeze(Object.keys(PRESETS));

/**
 * Resolve a preset id to its config, or `undefined` if unknown/unset.
 * @param {string} [id]
 * @returns {PagePersonaPreset|undefined}
 */
export function resolvePreset(id) {
	if (!id) return undefined;
	return PRESETS[id];
}

// ── Host-context sanitization ────────────────────────────────────────────

const CONTEXT_MAX_BYTES = 1024;
const CONTEXT_MAX_KEYS = 20;
const CONTEXT_MAX_VALUE_LEN = 200;
const CONTEXT_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Sanitize host-supplied context (the `context="{...}"` attribute, already
 * JSON-parsed) into a safe, flat string map:
 *   - non-object / array input → `{}`
 *   - non-string values are dropped (string values only)
 *   - unsafe/malformed keys are dropped (`__proto__` etc., non `[a-zA-Z0-9_-]`)
 *   - each value has backticks/newlines stripped (fence- and line-injection
 *     safe) and is capped to 200 chars
 *   - the whole map is capped at ~1KB and 20 keys; entries beyond the budget
 *     are dropped, not truncated mid-value
 * @param {unknown} input
 * @returns {Record<string,string>}
 */
export function sanitizeContext(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
	const out = {};
	let bytes = 0;
	let count = 0;
	for (const key of Object.keys(input)) {
		if (count >= CONTEXT_MAX_KEYS) break;
		if (UNSAFE_KEYS.has(key) || !CONTEXT_KEY_PATTERN.test(key)) continue;
		const raw = input[key];
		if (typeof raw !== 'string') continue;
		const clean = raw
			.replace(/`/g, "'")
			.replace(/[\r\n]+/g, ' ')
			.trim()
			.slice(0, CONTEXT_MAX_VALUE_LEN);
		if (!clean) continue;
		const entryBytes = byteLength(key) + byteLength(clean) + 4; // ~overhead for ": " + separators
		if (bytes + entryBytes > CONTEXT_MAX_BYTES) break;
		out[key] = clean;
		bytes += entryBytes;
		count++;
	}
	return out;
}

function byteLength(str) {
	return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(str).length : str.length;
}

/**
 * Compose a preset's `systemRole` with sanitized host context into one
 * plain-text brief — for a host page (or a paired `<agent-3d chat>` on the
 * same page) to hand to a real LLM. `page-agent` never sends this anywhere
 * itself; it's exposed via `guide.systemPrompt`.
 *
 * The context block is a fenced, clearly-delimited section so a consuming
 * LLM can't confuse host data for instructions — values are pre-sanitized
 * (no backticks/newlines) so they can't break out of the fence.
 *
 * @param {PagePersonaPreset|undefined} preset
 * @param {Record<string,string>|undefined} context  Already-sanitized (see `sanitizeContext`).
 * @returns {string}
 */
export function buildSystemPrompt(preset, context) {
	const role = preset?.systemRole?.trim() || '';
	const sanitized = context && typeof context === 'object' ? context : {};
	const keys = Object.keys(sanitized);
	if (!keys.length) return role;

	const block = ['[Host page context]', ...keys.map((k) => `- ${k}: ${sanitized[k]}`)].join('\n');
	const fenced = '```\n' + block + '\n```';
	return role ? `${role}\n\n${fenced}` : fenced;
}

/**
 * Normalize `suggestedPrompts` input (preset default or explicit config) into
 * a consistent `{ prompt, response, action }[]`. Accepts plain strings (an
 * attribute-only override with just questions) as well as full objects.
 * @param {(string|{prompt:string, response?:string, action?:'narrate'|'tour'})[]|undefined} list
 * @returns {{prompt:string, response:string, action:'narrate'|'tour'}[]}
 */
export function normalizePrompts(list) {
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const p of list) {
		if (typeof p === 'string') {
			const prompt = p.trim();
			if (prompt) out.push({ prompt, response: prompt, action: 'narrate' });
			continue;
		}
		if (p && typeof p === 'object' && typeof p.prompt === 'string' && p.prompt.trim()) {
			out.push({
				prompt: p.prompt.trim(),
				response: typeof p.response === 'string' && p.response.trim() ? p.response.trim() : p.prompt.trim(),
				action: p.action === 'tour' ? 'tour' : 'narrate',
			});
		}
	}
	return out;
}

/**
 * Resolve the final persona config for a `PageAgent`/`<page-agent>` instance:
 * a `preset` id merged with explicit overrides, where explicit values always
 * win (decision #1 — "Explicit attributes always override preset values").
 * Pure and DOM-free by design so the precedence rules are directly testable
 * without a browser; `PageAgent`'s constructor calls this as-is.
 *
 * @param {{ preset?: string, context?: unknown, greeting?: string,
 *           suggestedPrompts?: (string|{prompt:string, response?:string, action?:string})[],
 *           tools?: string[] }} [config]
 * @returns {{
 *   preset: PagePersonaPreset|undefined,
 *   context: Record<string,string>,
 *   greeting: string|undefined,
 *   suggestedPrompts: {prompt:string, response:string, action:'narrate'|'tour'}[],
 *   tools: string[],
 *   systemPrompt: string,
 * }}
 */
export function resolvePersonaConfig(config = {}) {
	const preset = resolvePreset(config.preset);
	const context = sanitizeContext(config.context);
	const tools = config.tools ?? preset?.tools ?? [];
	const suggestedPrompts = normalizePrompts(config.suggestedPrompts ?? preset?.suggestedPrompts);
	const greeting = config.greeting ?? preset?.greeting;
	const systemPrompt = buildSystemPrompt(preset, context);
	return { preset, context, greeting, suggestedPrompts, tools, systemPrompt };
}

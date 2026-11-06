// Spectator-reaction rules — the single source of truth for which emoji a viewer
// may send on a live agent screen, and how aggressively one IP may pile them on.
//
// Pure logic only: no Redis, no HTTP, no env. The watch-intent endpoint imports
// this to validate + throttle reactions, and the validation test imports it
// directly (so the test never has to boot the whole serverless handler). The
// client keeps its own small copy of the visible set in src/reaction-overlay.js;
// THIS module is the authority the server enforces — the client list is cosmetic.

// The fixed allowlist. Order is the display order on the reaction bar. Keep this
// tight: a small, curated set is what lets the floating-emoji overlay stay
// readable and the per-emoji counters meaningful.
export const REACTION_EMOJI = Object.freeze(['🔥', '❤️', '👏', '🚀', '😂']);

const REACTION_SET = new Set(REACTION_EMOJI);

// One viewer (per IP) may land at most one reaction on a given agent per this
// window. Anything faster is dropped server-side — client throttling is only
// cosmetic, the server is the gate.
export const REACTION_THROTTLE_MS = 1_200;

// Reactions/counters live for this long after the last one, matching the watch
// intent window so a quiet agent's tallies fall out on their own.
export const REACTION_WINDOW_MS = 120_000;

// Cap how many recent reactions the stream replays per agent, so a flood can't
// grow the Redis list unbounded.
export const REACTION_RECENT_CAP = 24;

/**
 * Normalize an arbitrary client value to a canonical allowlisted emoji, or null
 * when it isn't one. Tolerates surrounding whitespace and the VARIATION SELECTOR
 * forms a client might or might not send (e.g. ❤ vs ❤️), but never invents a
 * reaction that isn't on the list.
 *
 * @param {unknown} raw
 * @returns {string|null} the canonical emoji from REACTION_EMOJI, or null.
 */
export function normalizeReaction(raw) {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (REACTION_SET.has(trimmed)) return trimmed;
	// Reconcile the heart that some platforms send without its emoji-presentation
	// selector (U+FE0F). Map both the bare and presented forms onto the canonical.
	const stripped = trimmed.replace(/️/g, '');
	for (const e of REACTION_EMOJI) {
		if (e.replace(/️/g, '') === stripped) return e;
	}
	return null;
}

/** True when a reaction is on the allowlist. */
export function isAllowedReaction(raw) {
	return normalizeReaction(raw) !== null;
}

/**
 * Decide whether a reaction should be dropped because the same viewer reacted to
 * the same agent too recently. Pure so the decision is unit-testable; the caller
 * supplies the last-seen timestamp (from Redis) and the clock.
 *
 * @param {number|null|undefined} lastTs  epoch ms of this IP's last reaction on this agent
 * @param {number} now                    current epoch ms
 * @param {number} [windowMs]             throttle window
 * @returns {boolean} true ⇒ throttle (drop), false ⇒ allow
 */
export function shouldThrottleReaction(lastTs, now, windowMs = REACTION_THROTTLE_MS) {
	if (!Number.isFinite(lastTs) || lastTs <= 0) return false;
	return now - lastTs < windowMs;
}

/** Redis key for an agent's recent-reactions replay list (tailed by the stream). */
export function reactionsRecentKey(agentId) {
	return `agent:screen:${agentId}:reactions`;
}

/** Redis key for an agent's windowed reaction total (drives the live count). */
export function reactionsTotalKey(agentId) {
	return `agent:screen:${agentId}:rtotal`;
}

/** Redis key for the per-IP-per-agent reaction throttle marker. */
export function reactionThrottleKey(agentId, ip) {
	return `screen:react:t:${agentId}:${ip}`;
}

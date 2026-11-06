// Per-coin world gate config — a creator-set token threshold for entering a
// coin's Holders world (R24 token-gated worlds).
//
// By default a coin's Holders world gates on the platform's HOLDER_MIN_USD floor
// (see holder-pass.js). A coin's creator may instead pin a *token amount* —
// "hold ≥ X of the coin to enter" — that overrides the USD floor for their world
// only. Absent config = platform default, so existing worlds are unaffected
// unless a creator opts in.
//
// Storage reuses the shared KV (cache.js → Upstash in prod, in-memory in dev) —
// no new provider. The config is read by api/community/holder-pass.js when it
// prices a joining wallet, and read/written by api/community/world-gate.js (the
// creator panel). The multiplayer server never reads it directly: the signed
// holder pass carries the effective requirement, byte-verified server-side.

import { cacheGet, cacheSet, cacheDel } from './cache.js';

// The KV is durable Upstash in production. We use a long TTL and refresh it on
// every read so an actively-used gate never lapses; a year of total disuse
// expiring back to "platform default" is the safe direction to fail.
const TTL_S = 365 * 24 * 60 * 60;
const KEY = (mint) => `worldgate:${mint}`;

// Guard rails on a creator-set threshold: positive, finite, integer, and bounded
// so a fat-fingered or hostile value can't lock a world to an unreachable number
// (pump.fun supplies are ≤ 1e9 with 6 decimals → ≤ 1e15 base; cap there).
const MAX_MIN_TOKENS = 1e15;

/** Clamp an arbitrary input to a valid token threshold, or 0 when it's no gate. */
export function normalizeMinTokens(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(Math.floor(n), MAX_MIN_TOKENS);
}

/**
 * Read a coin's gate config, or null when the creator hasn't set one (the world
 * then uses the platform USD default). Best-effort: a KV failure reads as "no
 * config" so a transient store hiccup never wrongly locks a world.
 * @param {string} mint
 * @returns {Promise<{ minTokens: number, setBy: string, updatedAt: number } | null>}
 */
export async function readWorldGate(mint) {
	if (!mint) return null;
	let cfg;
	try {
		cfg = await cacheGet(KEY(mint));
	} catch {
		return null;
	}
	if (!cfg || typeof cfg !== 'object') return null;
	const minTokens = normalizeMinTokens(cfg.minTokens);
	if (minTokens <= 0) return null;
	// Touch the TTL so a live gate doesn't expire under an active community.
	cacheSet(KEY(mint), { ...cfg, minTokens }, TTL_S).catch(() => {});
	return {
		minTokens,
		setBy: typeof cfg.setBy === 'string' ? cfg.setBy : '',
		updatedAt: Number(cfg.updatedAt) || 0,
	};
}

/**
 * Set — or clear, when minTokens ≤ 0 — a coin's gate config.
 * @param {string} mint
 * @param {{ minTokens: number }} params
 * @param {string} setBy creator wallet that set it (for display/audit)
 * @returns {Promise<{ minTokens: number, setBy: string, updatedAt: number } | null>} the stored config, or null when cleared
 */
export async function writeWorldGate(mint, { minTokens }, setBy = '') {
	const n = normalizeMinTokens(minTokens);
	if (n <= 0) {
		await cacheDel(KEY(mint));
		return null;
	}
	const cfg = { minTokens: n, setBy: setBy || '', updatedAt: Date.now() };
	await cacheSet(KEY(mint), cfg, TTL_S);
	return cfg;
}

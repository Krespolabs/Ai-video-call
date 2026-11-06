/**
 * Net-Worth-Reactive Avatar — the client data/prefs layer.
 *
 * The agent wears its wallet: holdings, $THREE, fork lineage and reputation become
 * the 3D body's aura and the legible regalia of the presence panel. Every number
 * here is REAL — it comes from GET /api/agents/:id/solana/networth, which aggregates
 * real Solana balances (via api/_lib/balances.js), real $THREE holdings, and real
 * fork counts, and returns the canonical look/tier/marks so the galaxy star, the
 * profile hero, and the AR body always agree (one server truth, fetched once here).
 *
 * The server (api/_lib/networth-model.js) computes the canonical look/tier/marks;
 * this module fetches it and persists the owner's reactivity prefs (CSRF-gated).
 * The visual mapping itself lives in src/shared/wallet-networth.js (the aura) and
 * the shader (the galaxy); both share the server's tier vocabulary.
 */

import { formatWalletUsdSafe } from './wallet-format.js';

export const REACTIVITY_LEVELS = ['off', 'subtle', 'balanced', 'expressive'];
// `nameplate` controls the avatar's license-plate overlay (its public address +
// wealth-tier glyph), both default-on; the agent name is always shown. Mirrors the
// server contract in api/_lib/networth-model.js so the panel and the plate agree.
export const DEFAULT_PREFS = {
	reactivity: 'balanced',
	signals: { aura: true, events: true, reputation: true },
	nameplate: { address: true, tier: true },
};

export function normalizePrefs(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const reactivity = REACTIVITY_LEVELS.includes(r.reactivity) ? r.reactivity : DEFAULT_PREFS.reactivity;
	const sig = r.signals && typeof r.signals === 'object' ? r.signals : {};
	const np = r.nameplate && typeof r.nameplate === 'object' ? r.nameplate : {};
	return {
		reactivity,
		signals: { aura: sig.aura !== false, events: sig.events !== false, reputation: sig.reputation !== false },
		nameplate: { address: np.address !== false, tier: np.tier !== false },
	};
}

// ── Network ──────────────────────────────────────────────────────────────────

/**
 * Fetch the agent's real net-worth look. Returns the server payload, or `null`
 * when the read fails (callers then hold the last real state — never invent one).
 * @param {string} agentId
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object|null>}
 */
export async function fetchNetWorth(agentId, opts = {}) {
	if (!agentId) return null;
	try {
		const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/solana/networth`, {
			headers: { accept: 'application/json' },
			credentials: 'include',
			signal: opts.signal,
		});
		if (!r.ok) return null;
		const j = await r.json().catch(() => null);
		return j?.data || null;
	} catch {
		return null; // network/abort — hold last state
	}
}

let _csrf = null;
async function csrfToken() {
	if (_csrf && _csrf.expiresAt > Date.now() + 5_000) return _csrf.token;
	const r = await fetch('/api/csrf-token', { credentials: 'include' });
	if (!r.ok) throw new Error('Could not obtain a security token — sign in again.');
	const j = await r.json();
	_csrf = { token: j.data.token, expiresAt: Date.now() + (j.data.expires_in - 30) * 1000 };
	return _csrf.token;
}

/**
 * Persist the owner's reactivity preferences (owner-only, CSRF-gated server-side).
 * @param {string} agentId
 * @param {{reactivity?:string, signals?:object}} prefs
 * @returns {Promise<object>} the saved, normalized prefs
 */
export async function saveNetWorthPrefs(agentId, prefs) {
	const token = await csrfToken();
	_csrf = null; // single-use
	const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/solana/networth`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', 'x-csrf-token': token, accept: 'application/json' },
		credentials: 'include',
		body: JSON.stringify(prefs),
	});
	const j = await r.json().catch(() => ({}));
	if (!r.ok) throw Object.assign(new Error(j?.error_description || 'Could not save presence settings'), { status: r.status, code: j?.error });
	return j.data?.prefs || normalizePrefs(prefs);
}

// ── Formatting ───────────────────────────────────────────────────────────────

// Compact USD comes from the wallet program's one formatter so the inline
// net-worth figure reads identically to the wallet chip ($1.2K, not $1k).
export function fmtUsd(n) {
	return formatWalletUsdSafe(n);
}

export function fmtAmount(n) {
	const v = Number(n) || 0;
	if (v < 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
	if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
	if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	return `${(v / 1_000_000_000).toFixed(1)}B`;
}

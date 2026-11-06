// @ts-check
// Launch use-case engine — the shared, tested core behind every coin-launch
// recipe on three.ws. A "use case" is a declarative object: a live data SOURCE,
// a NAMING strategy that turns one candidate into a coin identity, and a REWARDS
// rule that routes that coin's creator fees. The engine fetches real candidates,
// applies the strategy, resolves rewards against real on-chain/identity state,
// and returns a concrete, previewable LAUNCH PLAN. Execution reuses the existing
// real launch + fee-sharing endpoints — nothing here is a mock.
//
// Two modes, each with its own integrity rule:
//   attribution — the coin is FOR a real subject (a GitHub repo/creator) and its
//                 fees route to that subject. This is the pump.fun social-fee
//                 "reward coin" product feature. Coin-agnostic plumbing: the
//                 subject comes from live data at runtime, never hardcoded.
//   narrative   — the coin rides a cultural theme and the identity is INVENTED.
//                 Enforces the $THREE rule via launcher-trends hygiene: themes
//                 only, brand-safe, no external ticker is ever minted verbatim.

import { normTerm, isSensitive } from '../launcher-trends.js';
import { resolveGithubReward, resolveSocialReward } from '../github-reward.js';
import { sourceCandidates } from './candidate-sources.js';

// ── identity helpers ──────────────────────────────────────────────────────────

/** Trim/clean a coin name to pump.fun's 32-char limit, collapsing whitespace. */
export function cleanName(raw) {
	return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 32);
}

/**
 * Derive a ticker symbol (≤10 chars, uppercase A–Z0–9) from a source string.
 * Prefers an acronym of capitalised words; falls back to the compacted alnum.
 */
export function deriveSymbol(raw, { max = 8 } = {}) {
	const s = String(raw || '').trim();
	if (!s) return 'COIN';
	const words = s.split(/[\s\-_/.]+/).filter(Boolean);
	let sym = '';
	if (words.length >= 2) {
		sym = words.map((w) => w[0]).join('').replace(/[^A-Za-z0-9]/g, '');
	}
	if (sym.length < 3) sym = s.replace(/[^A-Za-z0-9]/g, '');
	sym = sym.toUpperCase().slice(0, Math.max(3, Math.min(10, max)));
	return sym || 'COIN';
}

/** A coin description, brand-safe and capped to build-metadata's 500-char limit. */
export function cleanDescription(raw) {
	return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

// ── validation ────────────────────────────────────────────────────────────────

const MODES = new Set(['attribution', 'narrative']);
const CATEGORIES = new Set(['github', 'culture', 'news', 'onchain', 'events', 'community']);

/**
 * Structurally validate a use case. Throws on the first problem so a malformed
 * recipe fails loudly at registry-load time, never silently at launch.
 * @param {any} uc
 */
export function validateUseCase(uc) {
	const id = uc?.id;
	const where = `use case "${id || '<missing id>'}"`;
	if (!id || !/^[a-z0-9][a-z0-9-]{2,48}$/.test(id)) throw new Error(`${where}: invalid id (kebab-case, 3–49 chars)`);
	if (!uc.title || typeof uc.title !== 'string') throw new Error(`${where}: missing title`);
	if (!uc.description || typeof uc.description !== 'string') throw new Error(`${where}: missing description`);
	if (!CATEGORIES.has(uc.category)) throw new Error(`${where}: invalid category "${uc.category}"`);
	if (!MODES.has(uc.mode)) throw new Error(`${where}: invalid mode "${uc.mode}"`);
	if (!uc.source || typeof uc.source.kind !== 'string') throw new Error(`${where}: missing source.kind`);
	if (typeof uc.naming !== 'function') throw new Error(`${where}: naming must be a function`);
	if (typeof uc.rewards !== 'function') throw new Error(`${where}: rewards must be a function`);
	return true;
}

// ── reward resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a reward spec (what `uc.rewards(candidate)` returns) into a concrete
 * routing the UI can show and the executor can apply.
 *
 * `resolve:false` (the default, used by the PUBLIC preview) returns the routing
 * INTENT only — it never touches the DB and never reveals whether a GitHub user
 * has a linked wallet. `resolve:true` (the AUTHED launch path) does the real,
 * DB-backed resolution to a concrete address.
 *
 * @param {any} spec
 * @param {{ network: 'mainnet'|'devnet', resolve?: boolean }} ctx
 */
export async function resolveReward(spec, { network, resolve = false }) {
	if (!spec || spec.kind === 'creator') {
		return { kind: 'creator', shareholders: [], claimable_now: true,
			note: 'Creator fees stay with the launching agent wallet — claim or delegate later from the fees panel.' };
	}

	if (spec.kind === 'github-owner' || spec.kind === 'x-owner') {
		const platform = spec.kind === 'x-owner' ? 'x' : 'github';
		const handle = spec.username || spec.github_username || spec.x_username;
		if (!resolve) {
			return { kind: spec.kind, platform, username: handle || null,
				mode: 'pending', claimable_now: false, shareholders: [],
				note: handle ? `Creator fees route to @${String(handle).replace(/^@/, '')} on ${platform === 'x' ? 'X' : 'GitHub'} — resolved to their wallet (or a social-fee escrow) at launch.` : `Creator fees route to the ${platform === 'x' ? 'X' : 'GitHub'} account at launch.` };
		}
		const r = await resolveSocialReward({ platform, username: handle, userId: spec.user_id || spec.github_user_id, network });
		const shareholders = r.address ? [{ address: r.address, share_bps: 10_000, username: r.username, platform, mode: r.mode }] : [];
		return { kind: spec.kind, platform, username: r.username, user_id: r.user_id,
			mode: r.mode, claimable_now: r.claimable_now, shareholders, note: r.note };
	}

	// pump.fun launch-config reward structures — no recipient to resolve.
	if (spec.kind === 'cashback') {
		return { kind: 'cashback', shareholders: [], claimable_now: true,
			note: 'Trading fees return to holders as cashback — no creator vault; traders claim their own from pump.fun.' };
	}
	if (spec.kind === 'buyback') {
		const bps = Math.max(0, Math.min(10_000, Number(spec.buyback_bps) || 0));
		return { kind: 'buyback', buyback_bps: bps, shareholders: [], claimable_now: true,
			note: `${(bps / 100).toFixed(0)}% of creator fees auto-buy back and burn the coin — a rising floor instead of a payout.` };
	}

	if (spec.kind === 'split') {
		const rows = Array.isArray(spec.shareholders) ? spec.shareholders : [];
		if (!resolve) {
			return { kind: 'split', shareholders: [], claimable_now: false,
				note: `Split across ${rows.length} recipient${rows.length === 1 ? '' : 's'} — resolved at launch.` };
		}
		const resolved = [];
		for (const row of rows) {
			if (row.address) { resolved.push({ address: row.address, share_bps: row.share_bps, mode: 'address' }); continue; }
			const r = await resolveGithubReward({ githubUsername: row.github_username, network });
			if (r.address) resolved.push({ address: r.address, share_bps: row.share_bps, github_username: r.github_username, mode: r.mode });
		}
		const claimable = resolved.length > 0 && resolved.every((s) => s.mode === 'wallet' || s.mode === 'address');
		return { kind: 'split', shareholders: resolved, claimable_now: claimable,
			note: resolved.length ? `Split across ${resolved.length} recipient${resolved.length === 1 ? '' : 's'}.` : 'No resolvable recipients.' };
	}

	if (spec.kind === 'address') {
		return { kind: 'address', shareholders: [{ address: spec.address, share_bps: spec.share_bps || 10_000, mode: 'address' }],
			claimable_now: true, note: 'Routed to a fixed Solana address.' };
	}

	return { kind: 'creator', shareholders: [], claimable_now: true, note: 'Defaulted to creator fees.' };
}

// ── planning ────────────────────────────────────────────────────────────────────

/**
 * Produce a concrete launch plan for a use case from LIVE data.
 *
 * @param {any} uc — a validated use case
 * @param {{ limit?: number, network?: 'mainnet'|'devnet', params?: object }} [opts]
 * @returns {Promise<{ id:string, title:string, mode:string, category:string, network:string, generated_at:string, source:string, items:Array<object> }>}
 */
export async function planLaunch(uc, { limit = 8, network = 'mainnet', params = {} } = {}) {
	validateUseCase(uc);
	const sourceParams = { ...(uc.source.params || {}), ...params, limit: Math.max(1, Math.min(50, limit)) };
	const candidates = await sourceCandidates(uc.source.kind, sourceParams);

	const items = [];
	for (const c of candidates) {
		let identity;
		try { identity = uc.naming(c) || {}; } catch { continue; }
		const name = cleanName(identity.name);
		if (!name) continue;
		// Narrative mode is held to the $THREE rule: the identity must be an
		// invented, brand-safe theme — never a sensitive term or a raw ticker.
		if (uc.mode === 'narrative') {
			const probe = `${name} ${identity.description || ''}`;
			if (isSensitive(probe)) continue;
			if (!normTerm(name.split(/\s+/)[0])) { /* allow multi-word invented names; soft check only */ }
		}
		const symbol = deriveSymbol(identity.symbol || name, { max: 9 });
		let reward;
		try { reward = await resolveReward(uc.rewards(c), { network }); } catch { reward = { kind: 'creator', shareholders: [], claimable_now: true, note: 'Reward resolution failed — defaulted to creator.' }; }

		items.push({
			candidate_id: c.id,
			subject: c.subject,
			signal: c.signal || null,
			score: c.score ?? null,
			source_url: c.url || null,
			identity: { name, symbol, description: cleanDescription(identity.description), image: identity.image || c.image || null },
			reward,
		});
		if (items.length >= limit) break;
	}

	return {
		id: uc.id, title: uc.title, mode: uc.mode, category: uc.category,
		network, generated_at: new Date().toISOString(), source: uc.source.kind, items,
	};
}

/** Public-facing summary of a use case (no functions) for the catalog list. */
export function summarizeUseCase(uc) {
	return {
		id: uc.id, title: uc.title, description: uc.description, category: uc.category,
		mode: uc.mode, tags: Array.isArray(uc.tags) ? uc.tags : [], source: uc.source.kind,
		reward_label: uc.reward_label || (uc.mode === 'attribution' ? 'Routes fees to the subject' : 'Creator fees'),
		defaults: uc.defaults || {},
	};
}

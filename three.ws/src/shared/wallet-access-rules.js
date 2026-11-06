// Wallet access rules — the single, pure source of truth for what an agent's
// reputation unlocks across three.ws.
//
// Reputation is only meaningful if it is a KEY: it should open worlds, grant
// cosmetics, and signal trust. This module turns a server-computed reputation
// result into a transparent set of unlocks. It is intentionally PURE (no I/O):
//   • the server (api/_lib/trust/access.js) evaluates it authoritatively to gate
//     real capabilities — a tampered client can never flip an unlock here, because
//     the inputs (tier, score, $THREE held + duration) are all server-computed;
//   • the client (src/shared/wallet-access.js) evaluates the SAME rules to reflect
//     state and render a "what unlocks next" tracker, but the server enforces.
//
// Every unlock can be reached MORE THAN ONE way — typically "earn the tier" OR
// "hold $THREE" — so reputation and conviction in the platform coin are both real
// keys. Each condition is fully explainable: the UI shows exactly what's required,
// what the viewer has, and how close they are.

import { TIERS } from './agent-financial-reputation.js';

// Low → high. Mirrors the reputation tier ladder; `new` is the resting state.
export const TIER_ORDER = ['new', 'emerging', 'established', 'trusted', 'elite'];

export function tierRank(tier) {
	return TIERS[tier]?.rank ?? 0;
}

/**
 * The unlock catalog. Order is display order. `requires` is an array of
 * CONDITIONS; the unlock is granted if ANY one condition is fully met. Each
 * condition is an object of thresholds that are ANDed together, so e.g.
 * `{ minThreeUsd: 250, minThreeHoldDays: 14 }` means "hold $250 of $THREE for 14
 * days", while a sibling `{ minTier: 'trusted' }` offers the tier path instead.
 */
export const ACCESS_RULES = [
	{
		key: 'arena-elite-floor',
		label: 'Arena Elite Floor',
		blurb: "Stand on the arena's elite floor — a world area reserved for wallets the network already trusts.",
		surface: 'world',
		icon: '🏛',
		accent: '#fbbf24',
		requires: [{ minTier: 'trusted' }, { minThreeUsd: 250, minThreeHoldDays: 14 }],
	},
	{
		key: 'cosmetic-trusted-aura',
		label: 'Trusted Aura',
		blurb: 'A living violet aura on your avatar that signals a trusted wallet at a glance.',
		surface: 'cosmetic',
		icon: '✦',
		accent: '#a78bfa',
		requires: [{ minTier: 'trusted' }, { minThreeUsd: 100, minThreeHoldDays: 30 }],
	},
	{
		key: 'cosmetic-elite-finish',
		label: 'Elite Card Finish',
		blurb: 'The gold elite finish on your wallet trading card and profile.',
		surface: 'cosmetic',
		icon: '👑',
		accent: '#fbbf24',
		requires: [{ minTier: 'elite' }],
	},
	{
		key: 'world-holder-lounge',
		label: 'Holder Lounge',
		blurb: "A $THREE-holder-only world space — hold the coin to keep the key. Sell it all and the lounge locks again.",
		surface: 'world',
		icon: '🪙',
		accent: '#c4b5fd',
		requires: [{ minThreeUsd: 50 }, { minTier: 'elite' }],
	},
];

const clamp01 = (n) => Math.max(0, Math.min(1, n));

function fmtUsdShort(n) {
	n = Number(n) || 0;
	if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
	return `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;
}
function fmtDays(d) {
	d = Math.round(Number(d) || 0);
	return d === 1 ? '1 day' : `${d} days`;
}

// Evaluate one threshold-set condition against the viewer context. Returns the
// per-requirement parts (each explainable), whether the whole condition is met,
// and a 0..1 progress driven by the BINDING (least-satisfied) requirement.
function evaluateCondition(cond, ctx) {
	const parts = [];
	if (cond.minTier != null) {
		const need = tierRank(cond.minTier);
		const have = ctx.tierRank;
		parts.push({
			kind: 'tier',
			label: `Reach ${TIERS[cond.minTier]?.label || cond.minTier} tier`,
			met: have >= need,
			have: TIERS[ctx.tier]?.label || ctx.tier,
			need: TIERS[cond.minTier]?.label || cond.minTier,
			progress: need <= 0 ? 1 : clamp01(have / need),
		});
	}
	if (cond.minScore != null) {
		parts.push({
			kind: 'score',
			label: `Score ${cond.minScore}+`,
			met: ctx.score >= cond.minScore,
			have: `${Math.round(ctx.score)}`,
			need: `${cond.minScore}`,
			progress: clamp01(ctx.score / cond.minScore),
		});
	}
	if (cond.minThreeUsd != null) {
		parts.push({
			kind: 'three_usd',
			label: `Hold ${fmtUsdShort(cond.minThreeUsd)} of $THREE`,
			met: ctx.threeUsd >= cond.minThreeUsd,
			have: fmtUsdShort(ctx.threeUsd),
			need: fmtUsdShort(cond.minThreeUsd),
			progress: clamp01(ctx.threeUsd / cond.minThreeUsd),
		});
	}
	if (cond.minThreeHoldDays != null) {
		parts.push({
			kind: 'three_days',
			label: `Hold $THREE for ${fmtDays(cond.minThreeHoldDays)}`,
			met: ctx.threeHoldDays >= cond.minThreeHoldDays,
			have: fmtDays(ctx.threeHoldDays),
			need: fmtDays(cond.minThreeHoldDays),
			progress: clamp01(ctx.threeHoldDays / cond.minThreeHoldDays),
		});
	}
	const met = parts.length > 0 && parts.every((p) => p.met);
	const progress = parts.length ? Math.min(...parts.map((p) => p.progress)) : 0;
	return { met, progress, parts };
}

/**
 * Evaluate one unlock rule against the viewer context.
 *
 * @param {object} rule one ACCESS_RULES entry
 * @param {object} ctx { tier, tierRank, score, isNew, threeUsd, threeHoldDays }
 * @returns {object} { key, label, blurb, surface, icon, accent, unlocked,
 *                      conditions[], progress, nextHint }
 */
export function evaluateAccess(rule, ctx) {
	const conditions = rule.requires.map((cond) => evaluateCondition(cond, ctx));
	const unlocked = conditions.some((c) => c.met);
	// The most-complete path the viewer is on (for "what unlocks next").
	const best = conditions.reduce((a, b) => (b.progress > a.progress ? b : a), conditions[0] || { progress: 0, parts: [] });
	const progress = unlocked ? 1 : best.progress;
	let nextHint = null;
	if (!unlocked && best?.parts?.length) {
		const blocker = best.parts.find((p) => !p.met);
		if (blocker) nextHint = `${blocker.label} (you're at ${blocker.have})`;
	}
	return {
		key: rule.key,
		label: rule.label,
		blurb: rule.blurb,
		surface: rule.surface,
		icon: rule.icon,
		accent: rule.accent,
		unlocked,
		progress,
		conditions,
		nextHint,
	};
}

/** Evaluate every rule. Returns an array in catalog order. */
export function evaluateAllAccess(ctx) {
	const c = normalizeContext(ctx);
	return ACCESS_RULES.map((rule) => evaluateAccess(rule, c));
}

/** Look up + evaluate a single rule by key. Returns null for an unknown key. */
export function evaluateAccessKey(key, ctx) {
	const rule = ACCESS_RULES.find((r) => r.key === key);
	if (!rule) return null;
	return evaluateAccess(rule, normalizeContext(ctx));
}

/**
 * Build the viewer access context from a reputation result (the object returned by
 * getAgentReputation / the /reputation endpoint). All inputs are server-computed.
 */
export function buildAccessContext(rep) {
	return normalizeContext({
		tier: rep?.tier || 'new',
		score: rep?.score || 0,
		isNew: Boolean(rep?.isNew),
		threeUsd: rep?.totals?.three_usd || 0,
		threeHoldDays: rep?.totals?.three_hold_days || 0,
	});
}

function normalizeContext(ctx = {}) {
	const tier = ctx.tier || 'new';
	return {
		tier,
		tierRank: ctx.tierRank != null ? ctx.tierRank : tierRank(tier),
		score: Number(ctx.score) || 0,
		isNew: Boolean(ctx.isNew),
		threeUsd: Math.max(0, Number(ctx.threeUsd) || 0),
		threeHoldDays: Math.max(0, Number(ctx.threeHoldDays) || 0),
	};
}

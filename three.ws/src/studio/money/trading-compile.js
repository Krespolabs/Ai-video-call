/**
 * Trading Brain — rule compiler (P4)
 * ==================================
 * The Trading Brain is a *visual* rule: connected blocks the user draws (trigger
 * → filters → buy → exits → risk). This module is the single, framework-agnostic
 * source of truth that turns that visual rule into the two real backend shapes —
 * never a mock, never a paper config:
 *
 *   compileRuleToConfig(rule)      → the nested Strategy Object config the live
 *                                    engine validates + runs (api/_lib/strategy-schema.js,
 *                                    POST /api/strategies, the cron fan-out runner).
 *   configToSniperStrategy(config) → the flat sniper shape the honest historical
 *                                    backtester replays (POST /api/sniper/backtest).
 *
 * It also renders the rule to plain English (ruleToEnglish) so a trader always
 * sees, in their own words, exactly what their agent will do before it does it.
 *
 * Pure + dependency-free so it runs identically in the browser (Trading Brain UI)
 * and in node (unit tests) — the same compile the studio shows is the one the
 * server enforces.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** The shape persisted at meta.studio.trading.rule — the visual rule's data. */
export const DEFAULT_RULE = Object.freeze({
	name: 'My sniper',
	network: 'mainnet',
	trigger: { type: 'new_launch', max_age_minutes: 30 },
	filters: {
		min_market_cap_usd: null,
		max_market_cap_usd: 60000,
		min_liquidity_sol: null,
		require_socials: true,
		max_creator_launches: null,
		min_creator_graduated: null,
		require_sol_quote: true,
	},
	buy: { amount_sol: 0.1, max_slippage_bps: 500 },
	exits: { take_profit_pct: 100, stop_loss_pct: 40, trailing_stop_pct: null, max_hold_minutes: null },
	risk: { max_concurrent_positions: 3, cooldown_minutes: 0 },
});

function num(v) {
	if (v === '' || v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Named starting points a trader can apply in one tap, then tune. Each is a full,
 * valid rule (compiles + validates cleanly) tuned to a real risk posture — from
 * "protect capital" to "chase fresh launches". These are opinionated defaults, not
 * advice: every one still runs inside the owner's server-side guardrails.
 */
export const PRESETS = Object.freeze([
	{
		id: 'guardian', name: 'Guardian', tagline: 'Capital-first. Established coins, tight risk.',
		rule: {
			name: 'Guardian', trigger: { max_age_minutes: 120 },
			filters: { min_market_cap_usd: 30000, max_market_cap_usd: 250000, min_liquidity_sol: 15, require_socials: true, min_creator_graduated: 1, max_creator_launches: null, require_sol_quote: true },
			buy: { amount_sol: 0.05, max_slippage_bps: 300 },
			exits: { take_profit_pct: 40, stop_loss_pct: 20, trailing_stop_pct: 15, max_hold_minutes: 240 },
			risk: { max_concurrent_positions: 2, cooldown_minutes: 10 },
		},
	},
	{
		id: 'balanced', name: 'Balanced', tagline: 'The sensible default. Fresh but filtered.',
		rule: {
			name: 'Balanced', trigger: { max_age_minutes: 30 },
			filters: { min_market_cap_usd: null, max_market_cap_usd: 60000, min_liquidity_sol: 5, require_socials: true, min_creator_graduated: null, max_creator_launches: null, require_sol_quote: true },
			buy: { amount_sol: 0.1, max_slippage_bps: 500 },
			exits: { take_profit_pct: 100, stop_loss_pct: 40, trailing_stop_pct: null, max_hold_minutes: 120 },
			risk: { max_concurrent_positions: 3, cooldown_minutes: 3 },
		},
	},
	{
		id: 'hunter', name: 'Hunter', tagline: 'Early entries on brand-new launches.',
		rule: {
			name: 'Hunter', trigger: { max_age_minutes: 10 },
			filters: { min_market_cap_usd: null, max_market_cap_usd: 30000, min_liquidity_sol: null, require_socials: false, min_creator_graduated: null, max_creator_launches: null, require_sol_quote: true },
			buy: { amount_sol: 0.2, max_slippage_bps: 900 },
			exits: { take_profit_pct: 200, stop_loss_pct: 45, trailing_stop_pct: 25, max_hold_minutes: 60 },
			risk: { max_concurrent_positions: 5, cooldown_minutes: 0 },
		},
	},
	{
		id: 'moonshot', name: 'Moonshot', tagline: 'Highest risk. Tiny caps, big targets.',
		rule: {
			name: 'Moonshot', trigger: { max_age_minutes: 5 },
			filters: { min_market_cap_usd: null, max_market_cap_usd: 15000, min_liquidity_sol: null, require_socials: false, min_creator_graduated: null, max_creator_launches: null, require_sol_quote: true },
			buy: { amount_sol: 0.25, max_slippage_bps: 1200 },
			exits: { take_profit_pct: 400, stop_loss_pct: 55, trailing_stop_pct: 30, max_hold_minutes: 45 },
			risk: { max_concurrent_positions: 6, cooldown_minutes: 0 },
		},
	},
]);

/** Apply a preset id onto a fresh rule, preserving the trader's chosen network. */
export function applyPreset(id, { network = 'mainnet' } = {}) {
	const p = PRESETS.find((x) => x.id === id);
	if (!p) return emptyRule();
	return normalizeRule({ ...p.rule, network });
}

/** Which preset (if any) the current rule matches exactly — for highlighting. */
export function matchingPresetId(rule) {
	const target = JSON.stringify(stripName(normalizeRule(rule)));
	for (const p of PRESETS) {
		if (JSON.stringify(stripName(normalizeRule({ ...p.rule, network: normalizeRule(rule).network }))) === target) return p.id;
	}
	return null;
}

function stripName(r) { const { name, ...rest } = r; return rest; }

/**
 * Score a rule's aggressiveness on a 0–100 scale from its own parameters — bigger
 * size, deeper stops, wider slippage, fresher/smaller-cap targets, more concurrent
 * exposure, and loftier profit targets all push it up. Pure + deterministic so the
 * meter the UI shows matches what any test asserts. Returns a score, a human label,
 * and a tone token for styling.
 */
export function scoreRisk(rule) {
	const r = normalizeRule(rule);
	let s = 0;
	s += clamp((r.buy.amount_sol / 1) * 25, 0, 25);                       // per-trade size
	s += clamp(((r.exits.stop_loss_pct ?? 40) / 60) * 18, 0, 18);          // downside tolerated
	s += clamp((r.buy.max_slippage_bps / 1500) * 15, 0, 15);              // slippage ceiling
	const mc = r.filters.max_market_cap_usd;                              // cap ceiling: lower = fresher = riskier
	s += mc == null ? 15 : clamp(15 - (mc / 200000) * 12, 3, 15);
	if (!r.filters.require_socials) s += 8;                               // no socials gate
	s += clamp((r.risk.max_concurrent_positions / 8) * 10, 0, 10);        // concurrent exposure
	s += clamp(((r.exits.take_profit_pct ?? 0) / 300) * 9, 0, 9);         // profit ambition
	const score = Math.round(clamp(s, 0, 100));
	const label = score < 25 ? 'Conservative' : score < 50 ? 'Balanced' : score < 75 ? 'Aggressive' : 'Degen';
	const tone = score < 25 ? 'calm' : score < 50 ? 'balanced' : score < 75 ? 'warm' : 'hot';
	return { score, label, tone };
}

/** Deep-clone the default rule (so callers never mutate the frozen template). */
export function emptyRule() {
	return structuredClone(DEFAULT_RULE);
}

/**
 * Merge a stored/partial rule over the defaults so every block is always present
 * even if an older saved rule predates a field. Never mutates the input.
 */
export function normalizeRule(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = DEFAULT_RULE;
	return {
		name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : d.name,
		network: r.network === 'devnet' ? 'devnet' : 'mainnet',
		trigger: {
			type: 'new_launch',
			max_age_minutes: num(r.trigger?.max_age_minutes) ?? d.trigger.max_age_minutes,
		},
		filters: {
			min_market_cap_usd: num(r.filters?.min_market_cap_usd),
			max_market_cap_usd: num(r.filters?.max_market_cap_usd),
			min_liquidity_sol: num(r.filters?.min_liquidity_sol),
			require_socials: r.filters?.require_socials === true,
			max_creator_launches: num(r.filters?.max_creator_launches),
			min_creator_graduated: num(r.filters?.min_creator_graduated),
			require_sol_quote: r.filters?.require_sol_quote !== false,
		},
		buy: {
			amount_sol: num(r.buy?.amount_sol) ?? d.buy.amount_sol,
			max_slippage_bps: num(r.buy?.max_slippage_bps) ?? d.buy.max_slippage_bps,
		},
		exits: {
			take_profit_pct: num(r.exits?.take_profit_pct),
			stop_loss_pct: num(r.exits?.stop_loss_pct) ?? d.exits.stop_loss_pct,
			trailing_stop_pct: num(r.exits?.trailing_stop_pct),
			max_hold_minutes: num(r.exits?.max_hold_minutes),
		},
		risk: {
			max_concurrent_positions: num(r.risk?.max_concurrent_positions) ?? d.risk.max_concurrent_positions,
			cooldown_minutes: num(r.risk?.cooldown_minutes) ?? d.risk.cooldown_minutes,
		},
	};
}

/**
 * Compile the visual rule into the nested Strategy Object config the live engine
 * runs. This is the EXACT shape api/_lib/strategy-schema.js#normalizeStrategyConfig
 * accepts; the server re-normalizes + re-validates it, so the client compile can
 * never widen the leash.
 */
export function compileRuleToConfig(rule) {
	const r = normalizeRule(rule);
	return {
		network: r.network,
		entry: {
			trigger: 'new_launch',
			max_age_minutes: r.trigger.max_age_minutes,
			min_market_cap_usd: r.filters.min_market_cap_usd,
			max_market_cap_usd: r.filters.max_market_cap_usd,
			min_liquidity_sol: r.filters.min_liquidity_sol,
			require_socials: r.filters.require_socials,
			max_creator_launches: r.filters.max_creator_launches,
			min_creator_graduated: r.filters.min_creator_graduated,
			require_sol_quote: r.filters.require_sol_quote,
		},
		sizing: {
			amount_sol: r.buy.amount_sol,
			max_slippage_bps: r.buy.max_slippage_bps,
		},
		exits: {
			take_profit_pct: r.exits.take_profit_pct,
			stop_loss_pct: r.exits.stop_loss_pct,
			trailing_stop_pct: r.exits.trailing_stop_pct,
			max_hold_minutes: r.exits.max_hold_minutes,
		},
		risk: {
			max_concurrent_positions: r.risk.max_concurrent_positions,
			cooldown_minutes: r.risk.cooldown_minutes,
		},
	};
}

/**
 * Compile a nested config into the flat sniper-strategy shape the historical
 * backtester replays (api/_lib/strategy-backtest.js). `maxPriceImpactPct` comes
 * from the agent's server-side guardrails so the projection honors the same
 * circuit breaker the live trade will.
 */
export function configToSniperStrategy(config, { maxPriceImpactPct = null } = {}) {
	const c = config || {};
	const e = c.entry || {};
	const s = c.sizing || {};
	const x = c.exits || {};
	const amountSol = Number(s.amount_sol) > 0 ? Number(s.amount_sol) : 0.1;
	return {
		trigger: 'new_mint',
		per_trade_lamports: String(Math.floor(amountSol * LAMPORTS_PER_SOL)),
		slippage_bps: Number.isFinite(Number(s.max_slippage_bps)) ? Math.round(Number(s.max_slippage_bps)) : 500,
		max_price_impact_pct: num(maxPriceImpactPct),
		min_market_cap_usd: num(e.min_market_cap_usd),
		max_market_cap_usd: num(e.max_market_cap_usd),
		min_creator_graduated: num(e.min_creator_graduated),
		max_creator_launches: num(e.max_creator_launches),
		require_socials: e.require_socials === true,
		require_sol_quote: e.require_sol_quote !== false,
		take_profit_pct: num(x.take_profit_pct),
		stop_loss_pct: num(x.stop_loss_pct),
		trailing_stop_pct: num(x.trailing_stop_pct),
		max_hold_seconds: num(x.max_hold_minutes) != null ? Math.round(num(x.max_hold_minutes) * 60) : null,
	};
}

/**
 * Validate the rule for the things the UI must catch before save (the server
 * re-validates authoritatively). Returns { valid, errors:{ [field]: message } }.
 */
export function validateRule(rule) {
	const r = normalizeRule(rule);
	const errors = {};
	if (!(r.buy.amount_sol > 0)) errors['buy.amount_sol'] = 'Per-trade size must be greater than 0 SOL.';
	if (r.buy.amount_sol > 100) errors['buy.amount_sol'] = 'Per-trade size is capped at 100 SOL.';
	if (!(r.exits.stop_loss_pct > 0 && r.exits.stop_loss_pct < 100)) {
		errors['exits.stop_loss_pct'] = 'A stop-loss between 1% and 99% is required — every rule must define its downside.';
	}
	if (r.exits.take_profit_pct == null && r.exits.trailing_stop_pct == null && r.exits.max_hold_minutes == null) {
		errors['exits'] = 'Define at least one upside exit: take-profit, trailing stop, or max hold.';
	}
	if (r.filters.min_market_cap_usd != null && r.filters.max_market_cap_usd != null &&
		r.filters.min_market_cap_usd > r.filters.max_market_cap_usd) {
		errors['filters.max_market_cap_usd'] = 'Max market cap must be greater than min market cap.';
	}
	return { valid: Object.keys(errors).length === 0, errors };
}

const usd = (n) => '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * Render the rule as a plain-English sentence a trader can verify at a glance.
 * No hype, no guarantees — just exactly what the agent will do.
 */
export function ruleToEnglish(rule) {
	const r = normalizeRule(rule);
	const f = r.filters;
	const conds = [];
	if (r.trigger.max_age_minutes != null) conds.push(`launched in the last ${r.trigger.max_age_minutes} min`);
	if (f.max_market_cap_usd != null) conds.push(`market cap under ${usd(f.max_market_cap_usd)}`);
	if (f.min_market_cap_usd != null) conds.push(`market cap over ${usd(f.min_market_cap_usd)}`);
	if (f.min_liquidity_sol != null) conds.push(`at least ${f.min_liquidity_sol} SOL liquidity`);
	if (f.require_socials) conds.push('has socials');
	if (f.max_creator_launches != null) conds.push(`creator has ≤ ${f.max_creator_launches} prior launches`);
	if (f.min_creator_graduated != null) conds.push(`creator has graduated ≥ ${f.min_creator_graduated} coins`);
	if (f.require_sol_quote) conds.push('SOL-quoted');

	const when = conds.length ? conds.join(', ') : 'any new launch';
	const exits = [];
	if (r.exits.take_profit_pct != null) exits.push(`take profit at +${r.exits.take_profit_pct}%`);
	if (r.exits.stop_loss_pct != null) exits.push(`cut losses at −${r.exits.stop_loss_pct}%`);
	if (r.exits.trailing_stop_pct != null) exits.push(`trail the peak by ${r.exits.trailing_stop_pct}%`);
	if (r.exits.max_hold_minutes != null) exits.push(`exit after ${r.exits.max_hold_minutes} min`);

	return `When a new coin appears that is ${when}, buy ${r.buy.amount_sol} SOL ` +
		`(max ${(r.buy.max_slippage_bps / 100).toFixed(1)}% slippage), then ${exits.join(', ') || 'manage the exit manually'}. ` +
		`Hold at most ${r.risk.max_concurrent_positions} position${r.risk.max_concurrent_positions === 1 ? '' : 's'} at once` +
		`${r.risk.cooldown_minutes ? `, with a ${r.risk.cooldown_minutes} min cooldown between buys` : ''}.`;
}

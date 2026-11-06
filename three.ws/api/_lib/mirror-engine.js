/**
 * Custodial mirror-trade decision engine — PURE, deterministic, no DB / no network.
 *
 * Given a follow edge, the leader's detected trade, and the follower's live
 * spendable balance + remaining daily budget, it decides whether to mirror and at
 * what size. This is the money-adjacent core of task 09, so it is isolated and
 * unit-tested (tests/mirror-engine.test.js). Every "skip" carries a machine +
 * human reason so the owner can see exactly why a mirror didn't fire.
 *
 * It NEVER signs or moves funds — it only sizes the order. The actual execution
 * (api/_lib/agent-mirror.js) runs the sized order through the SAME shared spend
 * guardrails (api/_lib/agent-trade-guards.js) the discretionary trade endpoint
 * and the sniper use, so a runaway leader can never drain a follower: this engine
 * is the first clamp, the spend policy is the hard backstop.
 */

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// A buy sized below this is dust — not worth a tx fee, and pump curves reject it.
export const MIN_MIRROR_BUY_SOL = 0.0005;

/**
 * Validate + normalize a follow edge's tunables coming from owner input.
 * Returns { ok, value, error }. Never throws.
 */
export function normalizeFollowInput(raw = {}) {
	const sizing = ['fixed', 'proportional', 'pct_balance'].includes(raw.sizing_mode) ? raw.sizing_mode : 'proportional';
	const fixed = n(raw.fixed_sol);
	// Proportional defaults to 1:1 (100%) when the owner doesn't specify a ratio.
	const proportion = raw.proportion_pct == null || raw.proportion_pct === '' ? 100 : n(raw.proportion_pct);
	const pct = n(raw.pct_balance);
	const maxPerTrade = raw.max_per_trade_sol == null || raw.max_per_trade_sol === '' ? null : n(raw.max_per_trade_sol);
	const dailyBudget = raw.daily_budget_sol == null || raw.daily_budget_sol === '' ? null : n(raw.daily_budget_sol);
	const minLeader = n(raw.min_leader_sol);

	if (sizing === 'fixed' && fixed <= 0) return { ok: false, error: 'fixed_sol must be greater than 0' };
	if (sizing === 'proportional' && !(proportion > 0)) return { ok: false, error: 'proportion_pct must be greater than 0' };
	if (sizing === 'pct_balance' && !(pct > 0 && pct <= 100)) return { ok: false, error: 'pct_balance must be between 0 and 100' };
	if (maxPerTrade != null && maxPerTrade <= 0) return { ok: false, error: 'max_per_trade_sol must be greater than 0' };
	if (dailyBudget != null && dailyBudget <= 0) return { ok: false, error: 'daily_budget_sol must be greater than 0' };
	if (minLeader < 0) return { ok: false, error: 'min_leader_sol cannot be negative' };

	const cleanMints = (arr) => (Array.isArray(arr) ? arr : [])
		.map((m) => (typeof m === 'string' ? m.trim() : ''))
		.filter((m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m))
		.slice(0, 100);

	return {
		ok: true,
		value: {
			sizing_mode: sizing,
			fixed_sol: fixed,
			proportion_pct: sizing === 'proportional' ? proportion : 100,
			pct_balance: pct,
			max_per_trade_sol: maxPerTrade,
			daily_budget_sol: dailyBudget,
			min_leader_sol: minLeader,
			copy_sells: raw.copy_sells !== false,
			mint_allowlist: cleanMints(raw.mint_allowlist),
			mint_denylist: cleanMints(raw.mint_denylist),
		},
	};
}

/** Raw order size (SOL) from the sizing rule, before any clamping. */
export function rawMirrorSol(follow, { leaderSol = 0, followerBalanceSol = null } = {}) {
	switch (follow.sizing_mode) {
		case 'fixed': return n(follow.fixed_sol);
		case 'proportional': return n(leaderSol) * (n(follow.proportion_pct) / 100);
		case 'pct_balance':
			return followerBalanceSol == null ? NaN : n(followerBalanceSol) * (n(follow.pct_balance) / 100);
		default: return 0;
	}
}

/**
 * Decide whether — and at what size — to mirror one leader trade onto one follow.
 *
 * @param {object} p
 * @param {object} p.follow              the follow edge (sizing rule + leashes).
 * @param {object} p.leaderTrade         { side:'buy'|'sell', mint, leaderSol }.
 * @param {number|null} p.followerBalanceSol  follower's spendable SOL (needed for pct_balance + headroom).
 * @param {number} [p.spentTodaySol]     SOL already mirrored under this follow's daily budget today.
 * @param {boolean} [p.killed]           the follower agent's mirror kill switch.
 * @returns {{ action:'mirror'|'skip', side:'buy'|'sell', order_sol?:number, reason:string, detail?:string }}
 */
export function planMirror({ follow, leaderTrade, followerBalanceSol = null, spentTodaySol = 0, killed = false }) {
	const side = leaderTrade.side === 'sell' ? 'sell' : 'buy';
	const mint = leaderTrade.mint;

	if (killed) return skip(side, 'mirror_killed', 'Mirroring is paused by the kill switch.');
	if (!follow.enabled) return skip(side, 'follow_disabled', 'This follow is paused.');

	// Allow/deny lists apply to both directions — an owner who blocked a mint never
	// wants to hold OR be forced to keep it.
	const deny = Array.isArray(follow.mint_denylist) ? follow.mint_denylist : [];
	const allow = Array.isArray(follow.mint_allowlist) ? follow.mint_allowlist : [];
	if (deny.includes(mint)) return skip(side, 'mint_denylisted', 'This token is on your skip list.');
	if (allow.length > 0 && !allow.includes(mint)) return skip(side, 'mint_not_allowlisted', 'This token is not on your allow list.');

	// SELL — mirror the exit: sell the follower's full remaining balance of the
	// mint (the safe direction — selling brings SOL in). Sizing happens at execution
	// from the real on-chain token balance, so the engine only gates here.
	if (side === 'sell') {
		if (!follow.copy_sells) return skip('sell', 'sells_disabled', 'This follow does not mirror sells.');
		return { action: 'mirror', side: 'sell', reason: 'mirror_exit' };
	}

	// BUY — size + leash.
	const leaderSol = n(leaderTrade.leaderSol);
	if (follow.min_leader_sol > 0 && leaderSol > 0 && leaderSol < follow.min_leader_sol) {
		return skip('buy', 'below_min_leader', `Leader's ${leaderSol.toFixed(4)} SOL buy is below your ${follow.min_leader_sol} SOL floor.`);
	}

	let order = rawMirrorSol(follow, { leaderSol, followerBalanceSol });
	if (!Number.isFinite(order) || order <= 0) {
		return skip('buy', 'sizing_unavailable', 'Could not size this order (missing balance for % sizing).');
	}

	// Per-follow per-trade cap (the agent-level per_trade_sol cap is enforced again
	// at execution as the hard backstop).
	if (follow.max_per_trade_sol != null) {
		order = Math.min(order, follow.max_per_trade_sol);
	}

	// Per-follow daily budget (optional, stacks under the agent's own daily budget).
	if (follow.daily_budget_sol != null) {
		const remaining = follow.daily_budget_sol - n(spentTodaySol);
		if (remaining <= 0) return skip('buy', 'follow_daily_spent', 'This follow’s daily budget is already used up.');
		order = Math.min(order, remaining);
	}

	// Don't spend more than the wallet can cover (a fee/rent headroom is re-checked
	// on-chain at execution; this is the early, friendly clamp).
	if (followerBalanceSol != null) {
		order = Math.min(order, Math.max(0, followerBalanceSol - 0.004));
	}

	if (order < MIN_MIRROR_BUY_SOL) {
		return skip('buy', 'below_dust', `Sized order ${order.toFixed(5)} SOL is below the ${MIN_MIRROR_BUY_SOL} SOL minimum.`);
	}

	return { action: 'mirror', side: 'buy', order_sol: round6(order), reason: 'sized' };
}

function skip(side, reason, detail) {
	return { action: 'skip', side, reason, detail };
}

// Human-friendly labels for skip reasons, surfaced in the owner's mirror feed.
export const SKIP_LABELS = {
	mirror_killed: 'Kill switch on',
	follow_disabled: 'Follow paused',
	mint_denylisted: 'Token on skip list',
	mint_not_allowlisted: 'Not on allow list',
	sells_disabled: 'Sells not mirrored',
	below_min_leader: 'Leader buy too small',
	sizing_unavailable: 'Could not size order',
	follow_daily_spent: 'Daily budget used up',
	below_dust: 'Order too small',
	insufficient_sol: 'Wallet underfunded',
	per_trade_cap: 'Over per-trade cap',
	daily_budget: 'Over daily budget',
	price_impact: 'Price impact too high',
	wallet_frozen: 'Wallet frozen',
	firewall_blocked: 'Blocked by safety firewall',
	no_holding: 'Nothing to sell',
};

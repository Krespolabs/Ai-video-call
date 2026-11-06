// Oracle — exit-signal engine (pure).
//
// The agent action loop is entry-only: evaluateWatch decides what to BUY. Once in,
// a position was only ever settled passively, when the coin finally resolved
// (graduated / rugged / ATH known). That leaves the hardest half of a strategy —
// when to GET OUT — unmanaged: a coin whose thesis breaks the minute after entry
// is held to the bitter end.
//
// This module closes that gap. Given an open position and the coin's CURRENT
// conviction + market read, it produces an explicit exit call: a boolean, the
// trigger that fired, a plain-language reason, and an urgency the UI/alerts can
// rank on. It is PURE and fully unit-tested — the caller owns the I/O (loading the
// current verdict) and the action (alerting the owner, or, for an autonomous
// agent, selling). The triggers are ordered by decisiveness: realize a win first,
// cut a hard loss next, then bail on red flags and a broken thesis.

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Default exit policy. Callers override per-watch; these are conservative. */
export const DEFAULT_EXIT_CFG = Object.freeze({
	takeProfitMultiple: 3,   // realize at +3× on the position's entry market cap
	stopLossMultiple: 0,     // 0 disables a hard multiple stop
	exitBelowScore: 45,      // exit if conviction collapses below this (watch/avoid)
	maxConvictionDrop: 20,   // exit if conviction falls this many points from entry
});

/**
 * Decide whether an open position should be exited.
 *
 * @param {object} args
 * @param {object} args.position { entryConviction, entryTier }
 * @param {object} args.current  { score, tier, badges, multiple, smartMoneyExiting }
 *                               `multiple` = current market cap / entry market cap
 *                               (omit when unknown — profit/stop triggers just skip).
 * @param {object} [args.cfg]    policy overrides (see DEFAULT_EXIT_CFG)
 * @returns {{exit:boolean, trigger:string|null, reason:string, urgency:'none'|'normal'|'high'}}
 */
export function evaluateExit({ position = {}, current = {}, cfg = {} } = {}) {
	const c = { ...DEFAULT_EXIT_CFG, ...cfg };
	const entry = num(position.entryConviction, NaN);
	const cur = num(current.score, entry);
	const multiple = num(current.multiple, NaN);
	const badges = Array.isArray(current.badges) ? current.badges : [];

	// 1. Take profit — realize the win before it round-trips.
	if (Number.isFinite(multiple) && num(c.takeProfitMultiple) > 0 && multiple >= c.takeProfitMultiple) {
		return signal('take_profit', `up ${multiple.toFixed(1)}× — take profit`, 'normal');
	}

	// 2. Hard stop — cut a defined loss (opt-in; 0 disables).
	if (Number.isFinite(multiple) && num(c.stopLossMultiple) > 0 && multiple <= c.stopLossMultiple) {
		return signal('stop_loss', `down to ${multiple.toFixed(2)}× — stop loss`, 'high');
	}

	// 3. A red flag surfaced after entry — the structure or creator now reads dirty.
	if (badges.includes('pedigree-flag')) {
		return signal('red_flag', 'creator rug history surfaced — exit', 'high');
	}
	if (badges.includes('structure-flag')) {
		return signal('red_flag', 'a structural red flag surfaced — exit', 'high');
	}

	// 4. Smart money is unwinding the position in real time — the pedigree thesis broke.
	if (current.smartMoneyExiting) {
		return signal('smart_money_exit', 'smart money is exiting the position', 'high');
	}

	// 5. Conviction collapse — the fused thesis fell apart.
	if (Number.isFinite(cur) && cur <= num(c.exitBelowScore)) {
		return signal('conviction_collapse', `conviction fell to ${Math.round(cur)} (below ${c.exitBelowScore})`, 'high');
	}
	if (Number.isFinite(entry) && (entry - cur) >= num(c.maxConvictionDrop)) {
		return signal('conviction_drop', `conviction dropped ${Math.round(entry - cur)} pts from entry`, 'normal');
	}

	return { exit: false, trigger: null, reason: 'thesis intact — hold', urgency: 'none' };
}

function signal(trigger, reason, urgency) { return { exit: true, trigger, reason, urgency }; }

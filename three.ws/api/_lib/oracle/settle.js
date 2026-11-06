// Oracle — outcome grading (pure).
//
// Closes the learning loop. Once the data brain labels a coin's ground-truth
// outcome (graduated / rugged / all-time-high multiple), every agent action on
// that coin is graded here: did the conviction call pay off? This is what turns
// the action ledger into an honest win-rate record and what lets the conviction
// backtest report real numbers instead of promises.
//
// Pure: takes one action row + the coin's outcome and returns the settled
// fields. The worker does the I/O.

const num = (v) => (v == null ? null : Number(v));

/**
 * @param {object} action  oracle_watch_actions row { size_sol, entry_mc_usd }
 * @param {object|null} outcome  pump_coin_outcomes row { graduated, rugged, ath_multiple, last_market_cap_usd }
 * @returns {{ settled:boolean, outcome:string, peak_multiple:number|null, realized_pnl_sol:number|null }}
 */
export function gradeAction(action, outcome) {
	if (!outcome) return { settled: false, outcome: 'open', peak_multiple: null, realized_pnl_sol: null };

	const graduated = !!outcome.graduated;
	const rugged = !!outcome.rugged;
	const peak = num(outcome.ath_multiple);
	const entryMc = num(action?.entry_mc_usd);
	const lastMc = num(outcome.last_market_cap_usd);

	// Nothing to grade yet — outcome row exists but carries no resolved signal.
	if (!graduated && !rugged && peak == null && lastMc == null) {
		return { settled: false, outcome: 'open', peak_multiple: peak, realized_pnl_sol: null };
	}

	const size = num(action?.size_sol) || 0;
	// Honest mark-to-market: value vs. entry from the last observed market cap.
	// We don't model an exit, so this is the position's standing mark, not a
	// realized sell. Null when we can't anchor an entry.
	const mark = entryMc && lastMc ? lastMc / entryMc : null;
	const realized_pnl_sol = mark != null ? +(size * (mark - 1)).toFixed(6) : null;

	// Loss conditions outrank a peak-based win: a coin that spiked 2× and then
	// rugged (or is marked down >50% from entry) was not a winning call — nobody
	// systematically exits at the wick. Graduation alone overrides, since a
	// graduated coin has a real market regardless of the later pump.fun mark.
	let label;
	if (graduated) label = 'win';
	else if (rugged || (mark != null && mark < 0.5) || (peak != null && peak < 1.2)) label = 'loss';
	else if (peak != null && peak >= 2) label = 'win';
	else label = 'flat';

	return { settled: true, outcome: label, peak_multiple: peak, realized_pnl_sol };
}

/**
 * Roll a set of graded actions into an agent's win-rate summary. Pure.
 * @param {Array<{outcome:string, realized_pnl_sol:number|null, size_sol:number}>} actions
 */
export function summarizeActions(actions = []) {
	let wins = 0, losses = 0, open = 0, pnl = 0, sized = 0;
	for (const a of actions) {
		if (a.outcome === 'win') wins += 1;
		else if (a.outcome === 'loss') losses += 1;
		else if (a.outcome === 'open' || a.outcome == null) open += 1;
		if (a.realized_pnl_sol != null) pnl += Number(a.realized_pnl_sol);
		if (a.size_sol != null) sized += Number(a.size_sol);
	}
	const resolved = wins + losses;
	return {
		total: actions.length,
		wins, losses, open,
		win_rate: resolved ? Math.round((wins / resolved) * 100) : null,
		realized_pnl_sol: +pnl.toFixed(6),
		deployed_sol: +sized.toFixed(6),
		roi_pct: sized > 0 ? Math.round((pnl / sized) * 100) : null,
	};
}

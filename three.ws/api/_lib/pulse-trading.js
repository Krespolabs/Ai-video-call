// Pure derivations for the Pulse "Trading viability" view.
//
// Deliberately free of SQL/DB/HTTP so the money math the panel — and any agent
// client hitting GET /api/pulse?view=trading — depends on can be unit-pinned. The
// handler in api/pulse.js runs the queries and feeds the raw rows through these.
//
// Invariant the panel leans on: a window's `trades` is a straight pass-through of
// the COUNT the headline counter uses, so the viability panel can never drift from
// the number at the top of the page.

const LAMPORTS_PER_SOL = 1e9;

export const solFromLamports = (lamports) => Number(lamports || 0) / LAMPORTS_PER_SOL;

// One windowed custody-ledger aggregate row → the public window shape.
// Buys carry SOL out in amount_lamports (asset='SOL'); sells carry only token base
// units, so SUM(amount_lamports) over the window is exactly the SOL deployed into
// buys, and the average trade is that spend amortised over the buy count.
export function shapeTradingWindow(row) {
	const trades = Number(row?.trades || 0);
	const buys = Number(row?.buys || 0);
	const deployedSol = solFromLamports(row?.deployed_lamports);
	return {
		trades,
		buys,
		sells: Number(row?.sells || 0),
		deployed_sol: deployedSol,
		deployed_usd: Number(row?.deployed_usd || 0),
		traders: Number(row?.traders || 0),
		avg_trade_sol: buys > 0 ? deployedSol / buys : 0,
	};
}

// Closed-position P&L aggregate row → the public realized-P&L shape. `win_rate` is
// null (not 0) when nothing has closed yet, so a fresh pilot reads as "no closes"
// rather than a misleading 0% — the panel keys its empty state off closed_positions.
export function shapeTradingPnl(row) {
	const closed = Number(row?.closed_count || 0);
	const wins = Number(row?.wins || 0);
	return {
		net_sol: solFromLamports(row?.net_lamports),
		closed_positions: closed,
		wins,
		win_rate: closed > 0 ? wins / closed : null,
	};
}

// 7-day daily rows → zero-filled sparkline points (the SQL already zero-fills days).
export function shapeTradingSeries(rows) {
	return (rows || []).map((r) => ({
		label: r.label,
		day: r.day,
		trades: Number(r.trades || 0),
		deployed_sol: solFromLamports(r.deployed_lamports),
	}));
}

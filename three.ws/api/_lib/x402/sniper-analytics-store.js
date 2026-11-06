// api/_lib/x402/sniper-analytics-store.js
//
// Compute + persistence layer for the Sniper Trade Performance analytics feed.
//
// The x402 endpoint POST /api/x402/analytics aggregates the autonomous sniper's
// own real trade ledger (agent_sniper_positions — closed positions with a signed
// realized_pnl_lamports) into a performance report: win rate, average profit,
// worst loss, and total SOL volume snipped over a period. The x402 autonomous
// loop pays $0.01 USDC for that report on a schedule (registry entry
// `sniper-trade-analytics`), records it to x402_autonomous_log, and — via the
// storeValue hook below — appends every snapshot to sniper_trade_analytics and
// raises a low-win-rate alert the strategy auto-tuner / ops dashboard consumes.
//
// Schema + compute ownership lives here so the endpoint (writer of the report),
// the registry's extractSignal (lifts the headline metrics into signal_data),
// and the storeValue persistence all agree on the exact shape and the alert rule.

export const LAMPORTS_PER_SOL = 1_000_000_000;

// A sniper "win" is a closed position whose realized PnL is strictly positive.
// Below this win rate — once there are enough closed trades for the rate to be
// meaningful — the strategy is underperforming and the loop raises an alert so
// the auto-tuner can pull back sizing or tighten entry filters.
export const WIN_RATE_ALERT_THRESHOLD = 0.4; // 40%
// Don't alert on noise: a single losing trade is 0% win rate but says nothing.
export const MIN_ALERT_SAMPLE = 5;

function num(v) {
	const n = typeof v === 'string' ? parseFloat(v) : v;
	return Number.isFinite(n) ? n : 0;
}

function round(v, dp = 6) {
	const f = 10 ** dp;
	return Math.round(num(v) * f) / f;
}

/**
 * Turn a single aggregate row over agent_sniper_positions into the full
 * sniper-trade performance report. Pure — the caller supplies the live SOL/USD
 * price so USD conversions are deterministic and testable.
 *
 * @param {object} agg aggregate counts/sums (numbers or numeric strings):
 *   { closed, wins, losses, breakeven, volume_lamports, total_pnl_lamports,
 *     avg_pnl_lamports, worst_loss_lamports, best_win_lamports, avg_pnl_pct }
 * @param {object} opts
 * @param {number|null} opts.solUsd live SOL price in USD (null → USD fields null)
 * @param {string} opts.period period key (echoed back)
 * @param {string} opts.network 'mainnet' | 'devnet' | 'all'
 * @param {string} opts.report report id (echoed back)
 * @param {string} [opts.generatedAt] ISO timestamp (caller stamps it)
 */
export function buildSniperAnalytics(agg = {}, opts = {}) {
	const solUsd = opts.solUsd != null && num(opts.solUsd) > 0 ? num(opts.solUsd) : null;
	const lamToSol = (l) => round(num(l) / LAMPORTS_PER_SOL, 9);
	const solToUsd = (s) => (solUsd != null ? round(s * solUsd, 4) : null);

	const sample = Math.round(num(agg.closed));
	const wins = Math.round(num(agg.wins));
	const losses = Math.round(num(agg.losses));
	const breakeven = Math.round(num(agg.breakeven));

	const winRate = sample > 0 ? wins / sample : 0;

	const totalVolumeSol = lamToSol(agg.volume_lamports);
	const totalPnlSol = lamToSol(agg.total_pnl_lamports);
	const avgProfitSol = lamToSol(agg.avg_pnl_lamports);
	const worstLossSol = lamToSol(agg.worst_loss_lamports);
	const bestWinSol = lamToSol(agg.best_win_lamports);

	const alert =
		sample >= MIN_ALERT_SAMPLE && winRate < WIN_RATE_ALERT_THRESHOLD
			? {
					type: 'low_win_rate',
					win_rate: round(winRate, 4),
					threshold: WIN_RATE_ALERT_THRESHOLD,
					sample_size: sample,
					message:
						`Sniper win rate ${(winRate * 100).toFixed(1)}% is below the ` +
						`${(WIN_RATE_ALERT_THRESHOLD * 100).toFixed(0)}% floor over ${sample} closed trades — ` +
						`review entry filters / sizing.`,
				}
			: null;

	return {
		report: opts.report || 'sniper_trades',
		period: opts.period || '24h',
		network: opts.network || 'mainnet',
		sample_size: sample,
		wins,
		losses,
		breakeven,
		win_rate: round(winRate, 4),
		win_rate_pct: round(winRate * 100, 2),
		total_volume_sol: totalVolumeSol,
		total_volume_usdc: solToUsd(totalVolumeSol),
		total_pnl_sol: totalPnlSol,
		total_pnl_usdc: solToUsd(totalPnlSol),
		avg_profit_sol: avgProfitSol,
		avg_profit_usdc: solToUsd(avgProfitSol),
		avg_profit_pct: round(num(agg.avg_pnl_pct), 4),
		best_win_sol: bestWinSol,
		best_win_usdc: solToUsd(bestWinSol),
		worst_loss_sol: worstLossSol,
		worst_loss_usdc: solToUsd(worstLossSol),
		sol_price_usd: solUsd,
		alert,
		generated_at: opts.generatedAt || null,
	};
}

/**
 * Lift the headline, auto-tuning-actionable metrics out of a report for
 * x402_autonomous_log.signal_data. Tolerates either a full report or a raw
 * endpoint response (same field names).
 */
export function classifySniperSignal(r) {
	const o = r || {};
	return {
		report: o.report || 'sniper_trades',
		period: o.period || null,
		network: o.network || null,
		win_rate: o.win_rate ?? null,
		avg_profit_usdc: o.avg_profit_usdc ?? null,
		total_volume_sol: o.total_volume_sol ?? null,
		sample_size: o.sample_size ?? null,
		alert: o.alert || null,
	};
}

let _schemaReady = false;

/**
 * Create the analytics time-series table if absent. Idempotent; the in-process
 * guard avoids re-issuing the DDL after the first call. Mirrors the loop's
 * ensureSchema idiom (see api/_lib/x402/three-signal-store.js).
 */
export async function ensureSniperAnalyticsSchema(sql) {
	if (_schemaReady || !sql) return;
	await sql`
		CREATE TABLE IF NOT EXISTS sniper_trade_analytics (
			id                bigserial PRIMARY KEY,
			ts                timestamptz NOT NULL DEFAULT now(),
			period            text,
			network           text,
			sample_size       int,
			wins              int,
			losses            int,
			win_rate          double precision,
			total_volume_sol  double precision,
			total_pnl_sol     double precision,
			avg_profit_sol    double precision,
			avg_profit_usdc   double precision,
			worst_loss_sol    double precision,
			sol_price_usd     double precision,
			alert             jsonb,
			run_id            uuid,
			source            text NOT NULL DEFAULT 'x402-autonomous'
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS sniper_trade_analytics_ts_desc
			ON sniper_trade_analytics (ts DESC)
	`;
	_schemaReady = true;
}

/**
 * Append one analytics snapshot to the time series.
 * @param {Function} sql
 * @param {object} report a buildSniperAnalytics() result
 * @param {{ runId?: string, source?: string }} [meta]
 */
export async function insertSniperAnalytics(sql, report, meta = {}) {
	if (!sql || !report) return;
	await ensureSniperAnalyticsSchema(sql);
	await sql`
		INSERT INTO sniper_trade_analytics
			(ts, period, network, sample_size, wins, losses, win_rate,
			 total_volume_sol, total_pnl_sol, avg_profit_sol, avg_profit_usdc,
			 worst_loss_sol, sol_price_usd, alert, run_id, source)
		VALUES
			(now(), ${report.period}, ${report.network}, ${report.sample_size},
			 ${report.wins}, ${report.losses}, ${report.win_rate},
			 ${report.total_volume_sol}, ${report.total_pnl_sol}, ${report.avg_profit_sol},
			 ${report.avg_profit_usdc}, ${report.worst_loss_sol}, ${report.sol_price_usd},
			 ${report.alert ? JSON.stringify(report.alert) : null},
			 ${meta.runId || null}, ${meta.source || 'x402-autonomous'})
	`;
}

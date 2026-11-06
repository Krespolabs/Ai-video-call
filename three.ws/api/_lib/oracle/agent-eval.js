// Oracle — agent action decision (pure).
//
// Given an armed watch config and a freshly-scored coin, decide whether the
// agent should act, and at what size. Pure and fully tested: the worker handles
// the I/O (loading open-position counts, today's spend, then executing), but the
// rules that gate real money live here where they can be verified in isolation.

const TIER_RANK = { avoid: 0, watch: 1, lean: 2, strong: 3, prime: 4 };

/**
 * When size_scaling is enabled, scale the position up to 1.5× the base
 * per_trade_sol based on how far above the minimum threshold the score lands:
 *   scaleFactor = 1.0 + clamp((score - min_score) / (100 - min_score), 0, 1) × 0.5
 *
 * A coin at the exact minimum scores at 1.0× base; one at 100 scores at 1.5×.
 * The executor still applies its hard per-trade SOL cap on top.
 */
function scaledSize(base, score, minScore) {
	const range = 100 - minScore;
	if (range <= 0) return base;
	const factor = 1.0 + Math.max(0, Math.min(1, (score - minScore) / range)) * 0.5;
	// Round to 4 decimal places so the logged reason stays readable.
	return Math.round(base * factor * 10000) / 10000;
}

/**
 * @param {object} args
 * @param {object} args.watch  oracle_agent_watch row (armed, mode, min_score, min_tier, categories, per_trade_sol, max_daily_sol, max_open, require_smart_money, size_scaling)
 * @param {object} args.coin   scored coin { score, tier, category, smart_wallet_count }
 * @param {number} args.openCount       agent's currently-open positions
 * @param {number} args.spentTodaySol   agent's SOL committed today
 * @returns {{act:boolean, size:number, reason:string}}
 */
export function evaluateWatch({ watch, coin, openCount = 0, spentTodaySol = 0 }) {
	if (!watch || !watch.armed) return block('agent not armed');
	if (!coin) return block('no coin');

	const score = Number(coin.score) || 0;
	const minScore = Number(watch.min_score) || 0;
	if (score < minScore) return block(`conviction ${score} below threshold ${minScore}`);

	// Tier gate (coarser duplicate of score, but the owner set it explicitly).
	const minTier = watch.min_tier || 'watch';
	if ((TIER_RANK[coin.tier] ?? 0) < (TIER_RANK[minTier] ?? 0)) {
		return block(`tier ${coin.tier} below ${minTier}`);
	}

	// Narrative filter.
	const cats = Array.isArray(watch.categories) ? watch.categories : [];
	if (cats.length && !cats.includes(coin.category)) {
		return block(`narrative ${coin.category} not in watchlist`);
	}

	// Require proven money in the book.
	if (watch.require_smart_money !== false && (Number(coin.smart_wallet_count) || 0) < 1) {
		return block('no proven wallet in yet');
	}

	// Data-confidence gate. A high score built on mostly-defaulted inputs is a lead
	// to watch, not a call to size real money into. Block coins the engine flagged
	// as thin-data unless the owner explicitly opts in (allow_thin_data). Also honor
	// an explicit numeric floor when the coin carries a confidence value.
	const badges = Array.isArray(coin.badges) ? coin.badges : [];
	if (badges.includes('thin-data') && !watch.allow_thin_data) {
		return block('thin data — score rests on defaulted inputs');
	}
	const minConf = Number(watch.min_confidence) || 0;
	if (minConf > 0 && coin.confidence != null && Number(coin.confidence) < minConf) {
		return block(`data confidence ${Number(coin.confidence)} below ${minConf}`);
	}

	// Concurrency + budget caps.
	if (openCount >= (Number(watch.max_open) || 5)) {
		return block(`at max open positions (${openCount})`);
	}

	const base = Number(watch.per_trade_sol) || 0;
	if (base <= 0) return block('per-trade size is zero');

	// Conviction-weighted sizing: larger positions for higher-scoring coins.
	const size = watch.size_scaling ? scaledSize(base, score, minScore) : base;

	const maxDaily = Number(watch.max_daily_sol) || 0;
	if (maxDaily > 0 && spentTodaySol + size > maxDaily + 1e-9) {
		return block(`daily budget reached (${spentTodaySol.toFixed(3)}/${maxDaily} SOL)`);
	}

	const scalingNote = watch.size_scaling && size !== base ? ` → ${size} SOL (conviction-scaled)` : '';
	return { act: true, size, reason: `conviction ${score} ≥ ${minScore} (${coin.tier}); ${coin.smart_wallet_count || 0} smart in${scalingNote}` };
}

function block(reason) { return { act: false, size: 0, reason }; }

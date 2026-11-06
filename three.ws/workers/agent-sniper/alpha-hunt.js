// agent-sniper — alpha_hunt strategy scorer. Pure, no I/O, no async.
//
// Receives an intel record (same shape as onIntel in index.js) and a strategy
// row, returns { pass, score, reasons }. Alpha hunt targets low-cap coins with
// real buying activity, smart money presence, and high organic quality.

function n(v) {
	if (v == null) return null;
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

function hasFlag(risk_flags, flag) {
	if (!Array.isArray(risk_flags)) return false;
	return risk_flags.includes(flag);
}

/**
 * @param {object} rec   intel record from watcher.js finalize
 * @param {object} strat agent_sniper_strategies row (trigger = 'alpha_hunt')
 * @returns {{ pass: boolean, score: number, reasons: string[] }}
 */
export function scoreAlpha(rec, strat) {
	const reasons = [];
	let score = 0;

	const sig = rec.signals ?? {};

	const qualityScore    = n(rec.quality_score);
	const organicScore    = n(sig.organic_score);
	const smartMoneyCount = n(rec.smart_money_count ?? sig.smart_money_count);
	const smartMoneyScr   = n(rec.smart_money_score ?? sig.smart_money_score);
	const mcSol           = n(sig.mc_sol_first_seen);
	const buyCount        = n(sig.buy_count);
	const risk_flags      = Array.isArray(rec.risk_flags) ? rec.risk_flags : [];

	// ── hard filters (any failure → skip immediately) ────────────────────────

	// min quality_score
	const minQuality = n(strat.alpha_min_quality_score);
	if (minQuality != null) {
		if (qualityScore == null || qualityScore < minQuality) {
			return { pass: false, score: 0, reasons: ['quality_score_below_min'] };
		}
	}

	// min smart_money_count
	const minSmartMoney = n(strat.alpha_min_smart_money);
	if (minSmartMoney != null) {
		if (smartMoneyCount == null || smartMoneyCount < minSmartMoney) {
			return { pass: false, score: 0, reasons: ['smart_money_count_below_min'] };
		}
	}

	// min organic_score (strategy field is 0-100, signal is 0-1)
	const minOrganic = n(strat.alpha_min_organic_score);
	if (minOrganic != null) {
		const organicPct = organicScore != null ? organicScore * 100 : null;
		if (organicPct == null || organicPct < minOrganic) {
			return { pass: false, score: 0, reasons: ['organic_score_below_min'] };
		}
	}

	// max market cap in USD. Prefer the standard `max_market_cap_usd` (the field the
	// owner's $10k–$100k experiment actually sets); fall back to the alpha-only field
	// for legacy alpha strategies. Reading only `alpha_max_mcap_usd` silently dropped
	// the ceiling for every experiment strategy — that was a real out-of-band hole.
	const maxMcapUsd = n(strat.max_market_cap_usd) ?? n(strat.alpha_max_mcap_usd);
	if (maxMcapUsd != null) {
		// mc_sol_first_seen is in SOL; strategy provides USD cap.
		// We store/pass market_cap_usd on rec if available; else skip the check.
		const mcUsd = n(rec.market_cap_usd);
		if (mcUsd != null && mcUsd > maxMcapUsd) {
			return { pass: false, score: 0, reasons: ['mcap_above_max'] };
		}
	}

	// min market cap (standard field, shared with other strategies)
	const minMcapUsd = n(strat.min_market_cap_usd);
	if (minMcapUsd != null) {
		const mcUsd = n(rec.market_cap_usd);
		if (mcUsd == null || mcUsd < minMcapUsd) {
			return { pass: false, score: 0, reasons: ['mcap_below_min'] };
		}
	}

	// narrative keyword match (optional — only enforced if keywords are set)
	const keywords = Array.isArray(strat.alpha_narrative_keywords)
		? strat.alpha_narrative_keywords.filter(Boolean)
		: [];
	if (keywords.length > 0) {
		const haystack = [
			rec.name ?? '',
			rec.symbol ?? '',
			rec.narrative ?? '',
		].join(' ').toLowerCase();
		const matched = keywords.some(kw => haystack.includes(String(kw).toLowerCase()));
		if (!matched) {
			return { pass: false, score: 0, reasons: ['no_narrative_keyword_match'] };
		}
		reasons.push(`narrative_match:${keywords.filter(kw => haystack.includes(String(kw).toLowerCase())).join(',')}`);
	}

	// ── score computation ─────────────────────────────────────────────────────

	// +30 if quality_score >= 70
	if (qualityScore != null && qualityScore >= 70) {
		score += 30;
		reasons.push(`quality_score:${qualityScore}`);
	} else if (qualityScore != null) {
		reasons.push(`quality_score:${qualityScore}`);
	}

	// +20 if smart_money_count >= 2, +10 if >= 1
	if (smartMoneyCount != null && smartMoneyCount >= 2) {
		score += 20;
		reasons.push(`smart_money_count:${smartMoneyCount}`);
	} else if (smartMoneyCount != null && smartMoneyCount >= 1) {
		score += 10;
		reasons.push(`smart_money_count:${smartMoneyCount}`);
	}

	// +15 if organic_score >= 0.7, +10 if >= 0.5
	if (organicScore != null && organicScore >= 0.7) {
		score += 15;
		reasons.push(`organic_score:${organicScore.toFixed(3)}`);
	} else if (organicScore != null && organicScore >= 0.5) {
		score += 10;
		reasons.push(`organic_score:${organicScore.toFixed(3)}`);
	} else if (organicScore != null) {
		reasons.push(`organic_score:${organicScore.toFixed(3)}`);
	}

	// +10 if no risk_flags (or only 'low_volume')
	const significantFlags = risk_flags.filter(f => f !== 'low_volume');
	if (significantFlags.length === 0) {
		score += 10;
		reasons.push('clean_risk_flags');
	}

	// +5 if buy_count >= 20
	if (buyCount != null && buyCount >= 20) {
		score += 5;
		reasons.push(`buy_count:${buyCount}`);
	} else if (buyCount != null) {
		reasons.push(`buy_count:${buyCount}`);
	}

	// -20 if coordinated_cluster in risk_flags
	if (hasFlag(risk_flags, 'coordinated_cluster')) {
		score -= 20;
		reasons.push('penalty:coordinated_cluster');
	}

	// -10 if dev_sell in risk_flags
	if (hasFlag(risk_flags, 'dev_sell')) {
		score -= 10;
		reasons.push('penalty:dev_sell');
	}

	// note smart_money_score if present for log context
	if (smartMoneyScr != null) {
		reasons.push(`smart_money_score:${smartMoneyScr}`);
	}

	const pass = score >= 40;
	if (!pass) reasons.push(`score_too_low:${score}`);

	return { pass, score, reasons };
}

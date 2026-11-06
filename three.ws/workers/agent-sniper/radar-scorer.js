// agent-sniper — pre-launch radar entry scoring. Pure, no I/O.
//
// Given a detected launch precursor (a radar_event enriched with the triggering
// wallet's pedigree + the live smart-money read on the mint, once it exists) and a
// prelaunch_radar strategy row, decide whether to pre-arm the snipe. Mirrors
// scorer.js / claim-scorer.js: returns { pass, confidence, reasons }, and reasons
// always explains the verdict so the worker log shows WHY a precursor was acted on
// or passed over.
//
// The firewall (task 01) still gates the actual buy the instant the mint is real;
// this is the cheap pre-filter that decides whether a precursor is worth racing.

function n(v) {
	if (v == null || v === '') return null;
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

/**
 * @param {object} ev   detected precursor:
 *   { kind, trigger_wallet, new_wallet?, mint?, signature, observed_ms,
 *     watch: { reason, score, creator_graduated, realized_score, labels },
 *     funder_reputation?: { realized_score, labels, computed },  // smart money on the funder
 *     base_confidence }                                          // 0..1 from detection
 * @param {object} strat  agent_sniper_strategies row (trigger = 'prelaunch_radar')
 * @param {object} cfg    loadConfig() result (radar defaults)
 * @param {number} nowMs
 * @returns {{ pass: boolean, confidence: number, reasons: string[] }}
 */
export function scoreRadarEvent(ev, strat, cfg, nowMs = Date.now()) {
	const reasons = [];
	if (!ev || !ev.mint) return { pass: false, confidence: 0, reasons: ['no_mint'] };

	const watch = ev.watch || {};

	// ── freshness gate ─────────────────────────────────────────────────────────
	// A precursor we observe stale (worker restart / backfill) must not pre-arm a
	// snipe minutes after the floor already moved. radar_max_age_ms overrides the
	// worker default; the precursor's own age is measured from its block time.
	const maxAge = Number.isFinite(Number(strat.radar_max_age_ms)) && Number(strat.radar_max_age_ms) > 0
		? Number(strat.radar_max_age_ms)
		: cfg.radarMaxAgeMs;
	if (ev.observed_ms != null) {
		const age = nowMs - Number(ev.observed_ms);
		if (Number.isFinite(age) && age > maxAge) {
			return { pass: false, confidence: 0, reasons: [`precursor_stale:${Math.round(age / 1000)}s>${Math.round(maxAge / 1000)}s`] };
		}
		if (Number.isFinite(age) && age >= 0) reasons.push(`age:${Math.round(age / 1000)}s`);
	}

	// ── creator pedigree gate ──────────────────────────────────────────────────
	// The triggering creator (or the creator whose fresh wallet was funded) must
	// have graduated at least N coins. min_creator_graduated_radar overrides the
	// worker default. A watchlist entry added purely for smart-money reputation may
	// carry no creator_graduated; the smart-money path below covers that case.
	const minGrad = strat.min_creator_graduated_radar != null
		? n(strat.min_creator_graduated_radar)
		: cfg.radarMinCreatorGraduated;
	const graduated = n(watch.creator_graduated);
	const isSmartMoneyWatch = watch.reason === 'smart_money' || (Array.isArray(watch.labels) && watch.labels.includes('smart_money'));

	if (minGrad != null && minGrad > 0) {
		const meetsPedigree = graduated != null && graduated >= minGrad;
		if (!meetsPedigree && !isSmartMoneyWatch) {
			return { pass: false, confidence: 0, reasons: [`creator_too_few_graduated:${graduated ?? 'n/a'}<${minGrad}`] };
		}
		if (meetsPedigree) reasons.push(`creator_graduated:${graduated}`);
	}

	// ── smart-money funder gate ────────────────────────────────────────────────
	// require_smart_money_funder demands the triggering wallet (a watched smart-money
	// address) or the funder of the fresh deploy wallet be proven. The watch entry
	// itself is proof for a smart_money-reason wallet; otherwise consult the funder's
	// reputation read. Skips silently only when no reputation has been computed yet.
	if (strat.require_smart_money_funder === true) {
		const funderRep = ev.funder_reputation || null;
		const watchProven = isSmartMoneyWatch && (n(watch.realized_score) ?? 0) > 0;
		const funderProven = !!(funderRep && funderRep.computed && (n(funderRep.realized_score) ?? 0) >= (cfg.radarSmartMoneyMinScore ?? 70));
		if (!watchProven && !funderProven) {
			// Only block when we actually had reputation data and it failed; an
			// uncomputed funder (brand-new graph) shouldn't silently kill a strong
			// creator-pedigree signal — but require_smart_money_funder is explicit, so
			// we honour it strictly: no proof → no pre-arm.
			return { pass: false, confidence: 0, reasons: ['no_smart_money_funder'] };
		}
		reasons.push(watchProven ? 'smart_money_watch' : `smart_money_funder:${Math.round(n(funderRep.realized_score))}`);
	}

	// ── confidence: detection base, lifted by pedigree + reputation ────────────
	let confidence = clamp01(n(ev.base_confidence) ?? 0.5);
	if (graduated != null && graduated > 0) confidence += Math.min(0.2, graduated * 0.03);
	const watchScore = n(watch.score);
	if (watchScore != null) confidence += Math.min(0.15, (watchScore / 100) * 0.15);
	const funderRep = ev.funder_reputation || null;
	if (funderRep && funderRep.computed) {
		const rs = n(funderRep.realized_score) ?? 0;
		if (rs > 0) { confidence += Math.min(0.15, (rs / 100) * 0.15); reasons.push(`funder_rep:${Math.round(rs)}`); }
	}
	confidence = clamp01(confidence);

	if (watch.reason) reasons.push(`watch:${watch.reason}`);
	reasons.push(`kind:${ev.kind}`);

	return { pass: true, confidence: Number(confidence.toFixed(4)), reasons };
}

function clamp01(v) {
	const x = Number(v);
	if (!Number.isFinite(x)) return 0;
	return Math.max(0, Math.min(1, x));
}

// Behavioral anomaly engine for custodial agent wallets — the wallet's immune
// system. Pure, synchronous, deterministic, unit-testable. No I/O, no clock, no
// randomness: every function takes its live numbers as arguments so the same
// inputs always produce the same verdict (the orchestrator in
// api/_lib/anomaly-events.js feeds it real custody history + live counts).
//
// The model has three pieces:
//   1. computeBaseline(events, nowMs) — learns an agent's "normal" from its real
//      custody spend history (size, velocity, counterparties, active hours, assets).
//   2. scoreOutbound({ baseline, config, action, recent }) — scores one pending
//      outbound action against the baseline into an interpretable signal: a 0..1
//      score plus NAMED factors ("3.2× your largest-ever trade", "first payment to
//      this address", "12 spends in the last minute — far above your usual pace").
//   3. applyApproval(config, evt) — when an owner approves a flagged action, folds
//      that pattern into the config so the same action never re-trips (the wallet
//      gets smarter, not naggier).
//
// Combination is noisy-OR (1 − Π(1 − wᵢ)): independent weak signals compound but
// stay bounded in [0,1), and any single catastrophic signal dominates. Catastrophic
// factors (a brand-new high-value destination, a hard velocity spike) carry a
// `critical` severity that forces a freeze regardless of sensitivity — we accept a
// rare false positive there to never miss the drain-the-wallet case.

// ── tunables ──────────────────────────────────────────────────────────────────

// Below this many priced events an agent has too little history to trust tight
// baselines; we widen tolerances and only the most extreme signals can flag.
export const MIN_HISTORY = 5;

// Distinct destinations kept on the baseline (a hard cap so meta can't bloat).
const MAX_COUNTERPARTIES = 200;
// USD samples kept for the size distribution.
const MAX_USD_SAMPLES = 500;

// Absolute USD floors. A spend under the "ignorable" floor is never worth
// flagging on size/counterparty alone (dust); a spend over the "large" floor is
// material even when an agent has thin history.
const USD_DUST = 1;
const USD_LARGE_ABS = 250;

// Velocity: a hard burst (this many spends inside 60s) is treated as a critical
// signal on its own — this is the signature of a leaked-session drain that stays
// under the daily USD cap by making many small payments fast.
const BURST_1MIN_ABS = 8;
const BURST_10MIN_ABS = 20;

export const SENSITIVITY_PRESETS = Object.freeze({
	// freeze when score ≥ threshold. Lower threshold = more protective = more alerts.
	relaxed: { key: 'relaxed', label: 'Relaxed', threshold: 0.85, description: 'Only freezes on the clearest threats. Fewest alerts.' },
	balanced: { key: 'balanced', label: 'Balanced', threshold: 0.7, description: 'Recommended. Freezes on strong anomalies, lets normal behavior through.' },
	strict: { key: 'strict', label: 'Strict', threshold: 0.5, description: 'Freezes on the first sign of unusual activity. Most alerts.' },
});

export const DEFAULT_SENSITIVITY = 'balanced';

export function sensitivityPreset(key) {
	return SENSITIVITY_PRESETS[key] || SENSITIVITY_PRESETS[DEFAULT_SENSITIVITY];
}

// Human noun for a spend category, used in factor copy.
const CATEGORY_NOUN = { trade: 'trade', snipe: 'snipe', x402: 'payment', withdraw: 'withdrawal' };
function noun(category) {
	return CATEGORY_NOUN[category] || 'spend';
}

// ── config (owner-tunable, stored at agent_identities.meta.anomaly) ─────────────

export const ANOMALY_CONFIG_DEFAULTS = Object.freeze({
	enabled: true,
	sensitivity: DEFAULT_SENSITIVITY,
	// Patterns the owner has approved — folded into scoring so an approved action
	// never re-trips. Approving TEACHES these.
	allow_destinations: [],   // base58 destinations the owner blessed
	size_ceiling_usd: null,   // owner-approved largest-normal spend
	extra_hours: [],          // UTC hours (0–23) the owner marked normal
	// One-tap "sweep to safety" target. When set, a flagged owner can evacuate the
	// wallet to this address in a single tap (a normal audited withdraw).
	safe_address: null,
	updated_at: null,
});

function clampHour(h) {
	const n = Math.floor(Number(h));
	return Number.isFinite(n) && n >= 0 && n <= 23 ? n : null;
}

/** Coerce arbitrary input (DB meta or an API patch) into a clean config object. */
export function normalizeAnomalyConfig(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const sens = SENSITIVITY_PRESETS[r.sensitivity] ? r.sensitivity : DEFAULT_SENSITIVITY;
	const dests = Array.isArray(r.allow_destinations) ? r.allow_destinations : [];
	const seen = new Set();
	const allow = [];
	for (const d of dests) {
		const s = typeof d === 'string' ? d.trim() : '';
		if (s && !seen.has(s)) { seen.add(s); allow.push(s); }
		if (allow.length >= MAX_COUNTERPARTIES) break;
	}
	const hoursRaw = Array.isArray(r.extra_hours) ? r.extra_hours : [];
	const hours = [...new Set(hoursRaw.map(clampHour).filter((h) => h !== null))].sort((a, b) => a - b);
	const ceil = r.size_ceiling_usd;
	const safe = typeof r.safe_address === 'string' && r.safe_address.trim() ? r.safe_address.trim() : null;
	return {
		enabled: r.enabled !== false,
		sensitivity: sens,
		allow_destinations: allow,
		size_ceiling_usd: Number.isFinite(Number(ceil)) && Number(ceil) > 0 ? Number(ceil) : null,
		extra_hours: hours,
		safe_address: safe,
		updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
	};
}

export function getAnomalyConfig(meta) {
	return normalizeAnomalyConfig(meta?.anomaly);
}

// ── baseline ────────────────────────────────────────────────────────────────

function percentile(sortedAsc, p) {
	if (!sortedAsc.length) return 0;
	const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
	return sortedAsc[idx];
}

function toMs(v) {
	if (v == null) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : null;
}

/**
 * Learn an agent's normal spending behavior from its real custody spend events.
 * @param {Array<{usd:?number, destination:?string, asset:?string, category:?string, created_at:(string|number|Date)}>} events
 * @param {number} nowMs
 * @returns {object} baseline profile (JSON-serializable; cached in meta.anomaly_baseline)
 */
export function computeBaseline(events, nowMs = 0) {
	const rows = Array.isArray(events) ? events : [];
	const usd = [];
	const dests = new Map();           // destination -> count
	const assets = new Set();
	const hourCounts = new Array(24).fill(0);
	const hourBuckets = new Map();     // floor(ts/3600000) -> count (for velocity)
	let firstAt = null;
	let lastAt = null;

	for (const e of rows) {
		const ms = toMs(e?.created_at);
		const v = e?.usd;
		if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
			if (usd.length < MAX_USD_SAMPLES) usd.push(v);
		}
		const dest = typeof e?.destination === 'string' && e.destination.trim() ? e.destination.trim() : null;
		if (dest) dests.set(dest, (dests.get(dest) || 0) + 1);
		const asset = typeof e?.asset === 'string' && e.asset.trim() ? e.asset.trim() : null;
		if (asset) assets.add(asset);
		if (ms != null) {
			const h = new Date(ms).getUTCHours();
			hourCounts[h] += 1;
			const b = Math.floor(ms / 3_600_000);
			hourBuckets.set(b, (hourBuckets.get(b) || 0) + 1);
			if (firstAt == null || ms < firstAt) firstAt = ms;
			if (lastAt == null || ms > lastAt) lastAt = ms;
		}
	}

	const usdSorted = usd.slice().sort((a, b) => a - b);
	const usdSum = usdSorted.reduce((s, x) => s + x, 0);
	const perHour = [...hourBuckets.values()].sort((a, b) => a - b);
	// Most-active counterparties first, capped.
	const counterparties = [...dests.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_COUNTERPARTIES)
		.map(([d]) => d);
	const activeHours = hourCounts.map((c, h) => (c > 0 ? h : -1)).filter((h) => h >= 0);

	return {
		version: 1,
		n: usdSorted.length,
		total_events: rows.length,
		usd: {
			max: usdSorted.length ? usdSorted[usdSorted.length - 1] : 0,
			p95: percentile(usdSorted, 95),
			mean: usdSorted.length ? usdSum / usdSorted.length : 0,
			samples: usdSorted.length,
		},
		velocity: {
			per_hour_p95: percentile(perHour, 95),
			per_hour_max: perHour.length ? perHour[perHour.length - 1] : 0,
			active_hour_buckets: perHour.length,
		},
		counterparties,
		counterparty_count: dests.size,
		active_hours: activeHours,
		assets: [...assets],
		first_at: firstAt ? new Date(firstAt).toISOString() : null,
		last_at: lastAt ? new Date(lastAt).toISOString() : null,
		computed_at: nowMs ? new Date(nowMs).toISOString() : null,
	};
}

/** A fresh, empty baseline (no history yet). */
export function emptyBaseline() {
	return computeBaseline([], 0);
}

// ── scoring ───────────────────────────────────────────────────────────────────

// noisy-OR over independent factor weights.
function combine(weights) {
	let keep = 1;
	for (const w of weights) keep *= (1 - Math.min(0.999, Math.max(0, w)));
	return 1 - keep;
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Score one pending outbound action against the agent's baseline.
 *
 * Pure + total: never throws, never reads the clock. The orchestrator supplies
 * `action.atMs` (decision time) and `recent` (live velocity counts from a cheap
 * indexed query). Returns an interpretable verdict; the caller decides what to do
 * with `decision`.
 *
 * @param {object} o
 * @param {object} o.baseline   from computeBaseline()
 * @param {object} o.config     normalized anomaly config (owner-tuned + learned)
 * @param {object} o.action     { usdValue:?number, destination:?string, asset:?string, category:string, atMs:number }
 * @param {object} o.recent     { count_1min:number, count_10min:number } live counts incl. this action
 * @returns {{ score:number, decision:'allow'|'freeze', threshold:number, sensitivity:string,
 *            lowHistory:boolean, critical:boolean, factors:Array<{key,label,weight,severity}> }}
 */
export function scoreOutbound({ baseline, config, action, recent } = {}) {
	const b = baseline && typeof baseline === 'object' ? baseline : emptyBaseline();
	const cfg = normalizeAnomalyConfig(config);
	const a = action || {};
	const r = recent || {};
	const preset = sensitivityPreset(cfg.sensitivity);

	const usd = typeof a.usdValue === 'number' && Number.isFinite(a.usdValue) && a.usdValue >= 0 ? a.usdValue : null;
	const dest = typeof a.destination === 'string' && a.destination.trim() ? a.destination.trim() : null;
	const asset = typeof a.asset === 'string' && a.asset.trim() ? a.asset.trim() : null;
	const category = typeof a.category === 'string' ? a.category : '';
	const atMs = Number.isFinite(a.atMs) ? a.atMs : 0;
	const hour = atMs ? new Date(atMs).getUTCHours() : null;
	const lowHistory = (b.n || 0) < MIN_HISTORY;

	const allowDest = new Set(cfg.allow_destinations || []);
	const extraHours = new Set(cfg.extra_hours || []);
	const count1 = Number(r.count_1min) || 0;
	const count10 = Number(r.count_10min) || 0;

	const factors = [];

	// 1 — transaction size vs the largest the agent has ever spent.
	const ceiling = Math.max(Number(b.usd?.max) || 0, cfg.size_ceiling_usd || 0);
	if (usd != null && usd > USD_DUST && ceiling > 0) {
		const ratio = usd / ceiling;
		if (ratio > 1.15) {
			let w;
			if (ratio > 6) w = 0.9;
			else if (ratio > 3) w = 0.7;
			else if (ratio > 1.5) w = 0.45;
			else w = 0.18;
			if (lowHistory) w *= 0.5; // thin history → size baseline is unreliable
			const critical = ratio > 3 && usd >= USD_LARGE_ABS && !lowHistory;
			factors.push({
				key: 'size',
				label: `${round2(ratio).toFixed(1)}× your largest-ever ${noun(category)} ($${usd.toFixed(2)} vs $${ceiling.toFixed(2)})`,
				weight: round2(w),
				severity: critical ? 'critical' : w >= 0.45 ? 'high' : 'medium',
			});
		}
	} else if (usd != null && usd >= USD_LARGE_ABS && ceiling <= 0) {
		// No priced history at all but a materially large first spend.
		factors.push({
			key: 'size',
			label: `A $${usd.toFixed(2)} ${noun(category)} with no prior spending history to compare against`,
			weight: 0.4,
			severity: 'high',
		});
	}

	// 2 — destination never seen before. Weighted HARD when it's also high-value:
	// a brand-new high-value counterparty is the catastrophic case.
	if (dest && !allowDest.has(dest) && !(b.counterparties || []).includes(dest)) {
		const knownCount = b.counterparty_count || 0;
		const material = usd == null ? false : usd >= USD_LARGE_ABS || (ceiling > 0 && usd >= 0.5 * ceiling);
		const overCeiling = usd != null && ceiling > 0 && usd > ceiling;
		let w;
		let severity;
		if (lowHistory && knownCount < 2) {
			// Almost everything is "new" early on — only flag if materially large.
			w = material ? 0.6 : 0.2;
			severity = material ? 'high' : 'low';
		} else {
			w = overCeiling ? 0.85 : material ? 0.72 : 0.5;
			severity = overCeiling || (material && !lowHistory) ? 'critical' : 'high';
		}
		const verb = category === 'withdraw' ? 'withdrawal to' : 'payment to';
		factors.push({
			key: 'new_counterparty',
			label: `First ${verb} this address — never used before${material && usd != null ? `, and it’s ${usd >= USD_LARGE_ABS ? 'a large amount' : 'above half your usual ceiling'}` : ''}`,
			weight: round2(w),
			severity,
		});
	}

	// 3 — velocity spike. Evaluated even with no USD (covers unpriceable spends and
	// the drain-under-the-cap attack: many small payments in a tight window).
	if (count1 >= BURST_1MIN_ABS || count10 >= BURST_10MIN_ABS) {
		factors.push({
			key: 'velocity',
			label: count1 >= BURST_1MIN_ABS
				? `${count1} spends in the last minute — far above your normal pace`
				: `${count10} spends in 10 minutes — far above your normal pace`,
			weight: 0.9,
			severity: 'critical',
		});
	} else if (count10 >= 5) {
		// Relative spike vs the agent's busiest historical 10-minute-ish rate.
		// Approximate a normal 10-min ceiling from the busiest hour bucket.
		const normal10 = Math.max(2, Math.ceil((Number(b.velocity?.per_hour_max) || 0) / 6) + 1);
		const ratio = count10 / normal10;
		if (ratio >= 3) {
			factors.push({
				key: 'velocity',
				label: `${count10} spends in 10 minutes — about ${Math.round(ratio)}× your normal pace`,
				weight: round2(Math.min(0.7, 0.35 + 0.1 * ratio)),
				severity: 'high',
			});
		}
	}

	// 4 — off-hours. Only meaningful once the agent has a clear daily rhythm.
	if (hour != null && (b.active_hours || []).length > 0 && (b.active_hours || []).length <= 18 && (b.total_events || 0) >= 8) {
		if (!(b.active_hours || []).includes(hour) && !extraHours.has(hour)) {
			factors.push({
				key: 'off_hours',
				label: `First activity at this hour (${String(hour).padStart(2, '0')}:00 UTC) — outside your agent’s usual hours`,
				weight: 0.3,
				severity: 'medium',
			});
		}
	}

	// 5 — new asset (minor).
	if (asset && (b.assets || []).length > 0 && !(b.assets || []).includes(asset)) {
		factors.push({
			key: 'new_asset',
			label: `First time moving ${asset}`,
			weight: 0.2,
			severity: 'low',
		});
	}

	factors.sort((x, y) => y.weight - x.weight);
	const score = round2(combine(factors.map((f) => f.weight)));
	const critical = factors.some((f) => f.severity === 'critical');
	const decision = (critical || score >= preset.threshold) && cfg.enabled ? 'freeze' : 'allow';

	return {
		score,
		decision,
		threshold: preset.threshold,
		sensitivity: cfg.sensitivity,
		lowHistory,
		critical,
		factors,
	};
}

/** One-line plain-language summary of a verdict for notifications / the timeline. */
export function summarize(verdict) {
	const f = verdict?.factors?.[0];
	if (!f) return 'Nothing unusual.';
	if (verdict.factors.length === 1) return f.label;
	return `${f.label} (+${verdict.factors.length - 1} more signal${verdict.factors.length - 1 === 1 ? '' : 's'})`;
}

// ── learning (approve teaches the baseline) ─────────────────────────────────────

/**
 * Fold an approved flagged action into the config so the same pattern won't
 * re-trip. Returns a NEW normalized config (does not mutate). The owner approving
 * "yes this was me" is the highest-quality training signal we get.
 *
 * @param {object} config  current normalized config
 * @param {object} evt     the flagged anomaly event: { destination, usd, hour_utc }
 */
export function applyApproval(config, evt = {}) {
	const cfg = normalizeAnomalyConfig(config);
	const dest = typeof evt.destination === 'string' && evt.destination.trim() ? evt.destination.trim() : null;
	const allow = dest && !cfg.allow_destinations.includes(dest)
		? [...cfg.allow_destinations, dest].slice(-MAX_COUNTERPARTIES)
		: cfg.allow_destinations;
	const usd = Number(evt.usd);
	const ceiling = Number.isFinite(usd) && usd > 0
		? Math.max(cfg.size_ceiling_usd || 0, usd)
		: cfg.size_ceiling_usd;
	const hour = clampHour(evt.hour_utc);
	const hours = hour != null && !cfg.extra_hours.includes(hour)
		? [...cfg.extra_hours, hour].sort((a, b) => a - b)
		: cfg.extra_hours;
	return normalizeAnomalyConfig({
		...cfg,
		allow_destinations: allow,
		size_ceiling_usd: ceiling,
		extra_hours: hours,
	});
}

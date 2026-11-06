// api/_lib/x402/user-activity-analytics.js
//
// Real product-analytics computation over the platform's own activity tables.
// Backs the paid POST /api/x402/analytics endpoint AND the autonomous-loop
// snapshot persistence, so both always derive identical numbers from one place.
//
// Source of truth: usage_events (every API/MCP/render/llm call is metered here
// by api/_lib/usage.js) and sessions (web auth sessions). No mocks — every
// figure is a live SQL aggregate. An empty table yields zeros, never fabricated
// data.

// Supported reporting windows. The autonomous entry uses '7d'; callers may ask
// for a shorter or longer window. Each maps to a Postgres interval string.
export const PERIODS = {
	'24h': '24 hours',
	'7d': '7 days',
	'30d': '30 days',
};

export const DEFAULT_PERIOD = '7d';

// Normalize a caller-supplied period to a supported key (defaults to 7d).
export function normalizePeriod(period) {
	const p = String(period || '').toLowerCase().trim();
	return PERIODS[p] ? p : DEFAULT_PERIOD;
}

// A stable per-actor identity across the heterogeneous usage_events columns.
// An anonymous hit (all identity columns null) collapses to NULL and is
// excluded from DAU/WAU by COUNT(DISTINCT) — DAU/WAU count identifiable actors,
// not raw traffic. Order: human user → autonomous agent → API key → OAuth
// client → avatar owner. Trusted constant (no user input) — inlined into the
// raw SQL text below.
const ACTOR_KEY = `COALESCE(
	user_id::text,
	'agent:'  || agent_id::text,
	'apikey:' || api_key_id::text,
	'client:' || client_id,
	'avatar:' || avatar_id::text
)`;

// Round to a sensible number of decimals without dragging in a dependency.
const round = (n, d = 2) => {
	if (n == null || !Number.isFinite(Number(n))) return null;
	const f = 10 ** d;
	return Math.round(Number(n) * f) / f;
};

/**
 * Compute the user_activity report over the given window.
 *
 * @param {Function} sql   neon tagged-template client (api/_lib/db.js)
 * @param {string}   period  one of PERIODS keys; coerced via normalizePeriod
 * @returns {Promise<object>} the full report payload
 */
export async function computeUserActivity(sql, period = DEFAULT_PERIOD) {
	const key = normalizePeriod(period);
	const interval = PERIODS[key];

	// All aggregates run concurrently against the same logical "now()" window.
	// Each query is independently null-safe so a sparse table returns zeros.
	// The actor key is a trusted constant; the window interval is bound as a
	// parameter. Uses the explicit sql(text, params) form so the COALESCE actor
	// expression and FILTER clauses compose cleanly.
	const [activeRows, eventRows, featureRows, sessionRows] = await Promise.all([
		// DAU (last 24h) and WAU (last 7d) — distinct identifiable actors. These
		// two are fixed windows by definition regardless of the report period.
		sql(
			`SELECT
				COUNT(DISTINCT ${ACTOR_KEY})
					FILTER (WHERE created_at >= now() - interval '24 hours') AS dau,
				COUNT(DISTINCT ${ACTOR_KEY})
					FILTER (WHERE created_at >= now() - interval '7 days')  AS wau
			FROM usage_events
			WHERE created_at >= now() - interval '7 days'`,
		),
		// Volume + active-actor totals across the requested window.
		sql(
			`SELECT
				COUNT(*)                              AS total_events,
				COUNT(*) FILTER (WHERE status <> 'ok') AS error_events,
				COUNT(DISTINCT ${ACTOR_KEY})          AS active_actors
			FROM usage_events
			WHERE created_at >= now() - $1::interval`,
			[interval],
		),
		// Top features by event volume over the window. For tool_call rows the
		// specific MCP tool is the feature; otherwise the coarse kind is.
		sql(
			`SELECT
				CASE WHEN kind = 'tool_call' AND tool IS NOT NULL AND tool <> ''
					THEN tool ELSE kind END AS feature,
				COUNT(*)                   AS events,
				COUNT(DISTINCT ${ACTOR_KEY}) AS actors
			FROM usage_events
			WHERE created_at >= now() - $1::interval
			GROUP BY 1
			ORDER BY events DESC
			LIMIT 10`,
			[interval],
		),
		// Session-length distribution from web auth sessions active in the window.
		// Duration = last_seen_at - created_at, only non-negative durations.
		sql(
			`SELECT
				COUNT(*) AS count,
				AVG(EXTRACT(EPOCH FROM (last_seen_at - created_at)))                              AS avg_seconds,
				PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (last_seen_at - created_at))) AS median_seconds,
				PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (last_seen_at - created_at))) AS p90_seconds
			FROM sessions
			WHERE last_seen_at >= now() - $1::interval
			  AND last_seen_at >= created_at`,
			[interval],
		),
	]);

	const active = activeRows[0] || {};
	const ev = eventRows[0] || {};
	const sess = sessionRows[0] || {};

	const dau = Number(active.dau || 0);
	const wau = Number(active.wau || 0);
	const totalEvents = Number(ev.total_events || 0);
	const errorEvents = Number(ev.error_events || 0);

	const topFeatures = (featureRows || []).map((r) => ({
		feature: r.feature || 'unknown',
		events: Number(r.events || 0),
		actors: Number(r.actors || 0),
		share: totalEvents > 0 ? round(Number(r.events) / totalEvents, 4) : 0,
	}));

	return {
		report: 'user_activity',
		period: key,
		window: interval,
		// Stickiness: DAU/WAU is the canonical engagement ratio (0..1).
		dau,
		wau,
		stickiness: wau > 0 ? round(dau / wau, 3) : 0,
		active_actors: Number(ev.active_actors || 0),
		total_events: totalEvents,
		error_rate: totalEvents > 0 ? round(errorEvents / totalEvents, 4) : 0,
		top_features: topFeatures,
		session_length: {
			count: Number(sess.count || 0),
			avg_seconds: round(sess.avg_seconds, 1),
			median_seconds: round(sess.median_seconds, 1),
			p90_seconds: round(sess.p90_seconds, 1),
		},
		ts: new Date().toISOString(),
	};
}

// Lift the headline signal the autonomous loop records into x402_autonomous_log
// .signal_data and persists into the snapshot table. Tolerates a partial/empty
// report so a degraded run still records something coherent.
export function extractActivitySignal(report) {
	const r = report || {};
	return {
		dau: Number(r.dau || 0),
		wau: Number(r.wau || 0),
		top_feature: Array.isArray(r.top_features) && r.top_features.length
			? r.top_features[0].feature
			: null,
		stickiness: r.stickiness ?? null,
		total_events: Number(r.total_events || 0),
	};
}

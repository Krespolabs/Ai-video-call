// Club cover-charge revenue summary.
//
// Powers the `mode:"revenue"` branch of POST /api/x402/club-cover and the
// autonomous loop's "Cover Charge Revenue Summary" pipeline. It reports the
// monetization health of the three.ws Pole Club's social economy over a rolling
// window, drawn entirely from real on-chain settlement records — no estimates,
// no mocks:
//
//   • Door (cover charge) revenue — every settled payment to the club-cover
//     route, read from the canonical x402 settlement ledger (x402_audit_log,
//     event_type='payment_settled'). This is the headline `total_usdc`.
//   • Floor revenue, per act — settled dance tips (club_tips) grouped by the
//     dancer/act they were paid to. Each act is a distinct, individually
//     monetizable "club" within the venue, so it is the one revenue dimension
//     with a meaningful per-entity breakdown: `clubs[]`, and the top earner
//     surfaces as `top_club_id` / `top_club_revenue`.
//
// Together they answer "is the club's social economy making money, and which
// act is driving the floor?" — the signal the autonomous monitor watches.

import { sql } from '../db.js';

export const COVER_ROUTE = '/api/x402/club-cover';

// Whitelisted rolling windows. The request `period` is mapped to a concrete
// `since` timestamp in JS (never interpolated into SQL as an interval literal),
// so there is no injection surface and every branch shares one query shape.
const PERIOD_DAYS = { '24h': 1, '7d': 7, '14d': 14, '30d': 30 };
const DEFAULT_PERIOD = '7d';

/**
 * Resolve a requested period to a canonical key + ISO `since` boundary.
 * Unknown values fall back to 7d; 'all' reports lifetime revenue.
 */
export function normalizePeriod(period) {
	const p = String(period || DEFAULT_PERIOD).trim().toLowerCase();
	if (p === 'all') return { key: 'all', since: new Date(0).toISOString() };
	const days = PERIOD_DAYS[p];
	if (!days) return { key: DEFAULT_PERIOD, since: sinceForDays(PERIOD_DAYS[DEFAULT_PERIOD]) };
	return { key: p, since: sinceForDays(days) };
}

function sinceForDays(days) {
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Atomic USDC (6-decimal) → fixed-precision USDC string. Never NaN. */
export function atomicsToUsdc(atomics) {
	const n = Number(atomics || 0);
	if (!Number.isFinite(n)) return '0.000000';
	return (n / 1e6).toFixed(6);
}

/**
 * Build the full cover-charge revenue summary for a rolling window.
 * Reads only real settlement data; soft-fails each leg so a transient query
 * error degrades one number rather than the whole report.
 *
 * @param {{ period?: string }} [opts]
 */
export async function coverRevenueSummary({ period } = {}) {
	const { key, since } = normalizePeriod(period);

	// Door revenue: settled cover-charge payments on the club-cover route.
	let cover = { count: 0, unique_payers: 0, atomics: '0' };
	try {
		const [row] = await sql`
			SELECT
				count(*)::int AS count,
				count(DISTINCT payer)::int AS unique_payers,
				coalesce(sum(
					CASE WHEN amount_atomics ~ '^[0-9]+$' THEN amount_atomics::numeric ELSE 0 END
				), 0)::text AS atomics
			FROM x402_audit_log
			WHERE event_type = 'payment_settled'
				AND route = ${COVER_ROUTE}
				AND created_at >= ${since}::timestamptz
		`;
		if (row) cover = row;
	} catch (err) {
		console.warn('[club-cover-revenue] door query failed (soft 0)', err?.message || err);
	}

	// Floor revenue per act: settled tips grouped by dancer. Left join keeps an
	// act with zero tips in the window visible (revenue 0) so the roster is
	// stable as new acts are added — same shape the public leaderboard uses.
	let clubs = [];
	try {
		const rows = await sql`
			SELECT
				d.dancer AS club_id,
				d.display_name,
				coalesce(sum(t.amount_atomics), 0)::text AS atomics,
				count(t.*)::int AS tip_count
			FROM club_dancer_wallets d
			LEFT JOIN club_tips t
				ON t.dancer = d.dancer AND t.created_at >= ${since}::timestamptz
			GROUP BY d.dancer, d.display_name
			ORDER BY coalesce(sum(t.amount_atomics), 0) DESC, d.dancer ASC
		`;
		clubs = rows.map((r) => ({
			club_id: r.club_id,
			display_name: r.display_name || null,
			revenue_atomics: r.atomics,
			revenue_usdc: atomicsToUsdc(r.atomics),
			tip_count: r.tip_count,
		}));
	} catch (err) {
		console.warn('[club-cover-revenue] floor query failed (soft empty)', err?.message || err);
	}

	const coverAtomics = Number(cover.atomics || 0);
	const floorAtomics = clubs.reduce((sum, c) => sum + Number(c.revenue_atomics || 0), 0);
	const tipCount = clubs.reduce((sum, c) => sum + (c.tip_count || 0), 0);
	const top = clubs.find((c) => Number(c.revenue_atomics) > 0) || null;

	return {
		ok: true,
		mode: 'revenue',
		period: key,
		since,
		generated_at: new Date().toISOString(),
		// Headline: total cover-charge (door) revenue over the window.
		total_usdc: atomicsToUsdc(coverAtomics),
		cover: {
			total_usdc: atomicsToUsdc(coverAtomics),
			total_atomics: String(coverAtomics),
			count: cover.count || 0,
			unique_payers: cover.unique_payers || 0,
		},
		floor: {
			total_usdc: atomicsToUsdc(floorAtomics),
			total_atomics: String(floorAtomics),
			tip_count: tipCount,
		},
		// Combined social-economy take = door + floor.
		social_economy_usdc: atomicsToUsdc(coverAtomics + floorAtomics),
		clubs,
		club_count: clubs.length,
		top_club_id: top ? top.club_id : null,
		top_club_revenue: top ? top.revenue_usdc : '0.000000',
		top_club_display_name: top ? top.display_name : null,
	};
}

/**
 * Pure extractor (no I/O) — lifts the actionable signal out of a revenue
 * response body for x402_autonomous_log.signal_data. Tolerates a partial or
 * failed body so the autonomous loop never throws on a degraded response.
 */
export function extractCoverRevenueSignal(r) {
	if (!r || typeof r !== 'object') {
		return { total_usdc: null, top_club_id: null, top_club_revenue: null };
	}
	return {
		period: r.period ?? null,
		total_usdc: r.total_usdc ?? r.cover?.total_usdc ?? null,
		cover_count: r.cover?.count ?? null,
		unique_payers: r.cover?.unique_payers ?? null,
		floor_usdc: r.floor?.total_usdc ?? null,
		social_economy_usdc: r.social_economy_usdc ?? null,
		club_count: r.club_count ?? (Array.isArray(r.clubs) ? r.clubs.length : null),
		top_club_id: r.top_club_id ?? null,
		top_club_revenue: r.top_club_revenue ?? null,
		top_club_display_name: r.top_club_display_name ?? null,
	};
}

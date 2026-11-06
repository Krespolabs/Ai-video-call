// @ts-check
// Upstash Redis quota-burn visibility.
//
// The free plan ceils at 500,000 commands/month. When it is exhausted every
// `critical: true` limiter fails closed and ALL paid forge generations + x402
// payments 503 platform-wide (the June 2026 incident: ~42k commands/day burned
// the quota in ~12 days). This module reads the REAL daily command count so the
// burn rate is visible — in the forge health endpoint and as an ops alert —
// well before the ceiling, turning the upgrade into a deliberate decision rather
// than an outage post-mortem.
//
// It never fabricates a number: when usage cannot be read (no management
// credentials, or the stats API is unreachable) it reports `unknown` and
// degrades nothing. Two real sources are tried, in order:
//
//   1. Upstash Management API — GET https://api.upstash.com/v2/redis/stats/{id}
//      with HTTP Basic auth (UPSTASH_EMAIL : UPSTASH_MANAGEMENT_API_KEY). This
//      is the authoritative account-usage source; the per-store REST token
//      cannot read it.
//   2. Upstash REST `/stats/daily` — some deployments expose a daily usage
//      summary over the same REST credentials the limiter already uses. Used as
//      a fallback when management credentials are absent.

import { env } from './env.js';

export const REDIS_MONTHLY_BUDGET = 500_000;
// The daily budget the monthly ceiling implies — burn measured against this is
// what "on track" means: 100% of the daily budget projects to exactly the
// monthly ceiling.
export const REDIS_DAILY_BUDGET = REDIS_MONTHLY_BUDGET / 30; // ≈ 16_667/day

// Projected-monthly alert thresholds (projected = dailyCommands × 30).
export const REDIS_WARN_PROJECTED = 400_000; // 80% of the free ceiling
export const REDIS_CRITICAL_PROJECTED = 450_000; // 90% of the free ceiling

const STATS_TIMEOUT_MS = 4_000;
const MANAGEMENT_STATS_URL = 'https://api.upstash.com/v2/redis/stats';

/** fetch with a hard timeout; resolves to the Response or null on network error. */
async function timedFetch(url, options = {}) {
	try {
		return await fetch(url, { ...options, signal: AbortSignal.timeout(STATS_TIMEOUT_MS) });
	} catch {
		return null;
	}
}

// Pull a finite daily-command count out of whatever shape the stats payload
// takes. Upstash has changed these field names over time and the two sources
// disagree, so we probe the known shapes and bail to null rather than guess.
// Time-series fields ([{x,y}, …] or [[ts, y], …]) are reduced to their most
// recent sample — the current day's running total.
function extractDailyCount(body) {
	if (!body || typeof body !== 'object') return null;
	const root = /** @type {Record<string, unknown>} */ (body.result ?? body);

	for (const key of ['totalCommands', 'dailyCommands', 'daily_commands', 'commands', 'count']) {
		const n = Number(root[key]);
		if (Number.isFinite(n) && n >= 0) return n;
	}

	for (const key of ['dailyrequests', 'daily_requests', 'days', 'command_count']) {
		const last = lastSeriesValue(root[key]);
		if (last != null) return last;
	}
	return null;
}

// Reduce a time-series ([{x,y}], [[ts,y]], or [n]) to its most recent numeric y.
function lastSeriesValue(series) {
	if (!Array.isArray(series) || series.length === 0) return null;
	const last = series[series.length - 1];
	let y;
	if (Array.isArray(last)) y = Number(last[1]);
	else if (last && typeof last === 'object') y = Number(last.y ?? last.value ?? last.count);
	else y = Number(last);
	return Number.isFinite(y) && y >= 0 ? y : null;
}

async function fetchViaManagementApi() {
	const email = env.UPSTASH_EMAIL;
	const apiKey = env.UPSTASH_MANAGEMENT_API_KEY;
	const id = env.UPSTASH_REDIS_STORE_ID;
	if (!email || !apiKey || !id) return null;
	const auth = Buffer.from(`${email}:${apiKey}`).toString('base64');
	const res = await timedFetch(`${MANAGEMENT_STATS_URL}/${encodeURIComponent(id)}`, {
		headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
	});
	if (!res || !res.ok) return null;
	const body = await res.json().catch(() => null);
	return extractDailyCount(body);
}

async function fetchViaRestStats() {
	const url = env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	const res = await timedFetch(`${url.replace(/\/$/, '')}/stats/daily`, {
		headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
	});
	if (!res || !res.ok) return null;
	const body = await res.json().catch(() => null);
	return extractDailyCount(body);
}

/**
 * Read the current day's Redis command count from Upstash. Returns a finite
 * number, or null when usage cannot be determined (never a fabricated value).
 * @returns {Promise<number | null>}
 */
export async function fetchRedisDailyCommands() {
	try {
		const viaMgmt = await fetchViaManagementApi();
		if (Number.isFinite(viaMgmt)) return /** @type {number} */ (viaMgmt);
		const viaRest = await fetchViaRestStats();
		if (Number.isFinite(viaRest)) return /** @type {number} */ (viaRest);
	} catch {
		// fall through — burn visibility is best-effort, never throws to callers
	}
	return null;
}

/**
 * @typedef {Object} RedisBurn
 * @property {number | null} dailyCommands  today's command count (null = unknown)
 * @property {number} monthlyBudget         the free-plan ceiling
 * @property {number | null} projectedMonthly  dailyCommands × 30
 * @property {number | null} percentUsed     % of the daily budget consumed
 * @property {'ok' | 'warning' | 'critical' | 'unknown'} status
 */

/**
 * Classify a daily command count against the free-plan budget. Pure — the unit
 * tests drive it directly with a stubbed high count.
 * @param {number | null | undefined} dailyCommands
 * @returns {RedisBurn}
 */
export function evaluateRedisBurn(dailyCommands) {
	if (!Number.isFinite(dailyCommands) || /** @type {number} */ (dailyCommands) < 0) {
		return {
			dailyCommands: null,
			monthlyBudget: REDIS_MONTHLY_BUDGET,
			projectedMonthly: null,
			percentUsed: null,
			status: 'unknown',
		};
	}
	const daily = /** @type {number} */ (dailyCommands);
	const projectedMonthly = Math.round(daily * 30);
	const percentUsed = Number(((daily / REDIS_DAILY_BUDGET) * 100).toFixed(1));
	let status = /** @type {'ok' | 'warning' | 'critical'} */ ('ok');
	if (percentUsed > 90) status = 'critical';
	else if (percentUsed > 70) status = 'warning';
	return {
		dailyCommands: daily,
		monthlyBudget: REDIS_MONTHLY_BUDGET,
		projectedMonthly,
		percentUsed,
		status,
	};
}

/**
 * Build the ops alert for a burn reading, or null when no alert is warranted.
 * Pure — the cron sends whatever this returns; tests assert it directly.
 * @param {RedisBurn} burn
 * @returns {{ level: 'warning' | 'critical', title: string, message: string } | null}
 */
export function redisBurnAlert(burn) {
	if (!burn || burn.status === 'unknown' || !Number.isFinite(burn.projectedMonthly)) return null;
	const projected = /** @type {number} */ (burn.projectedMonthly);
	const k = Math.round(projected / 1000);
	if (projected >= REDIS_CRITICAL_PROJECTED) {
		return {
			level: 'critical',
			title: 'Redis quota CRITICAL — forge + x402 outage imminent',
			message:
				`Redis is on track to exceed quota: ${k}k/500k requests this month ` +
				`(${burn.percentUsed}% of the daily budget). Upgrade Upstash to Pay-As-You-Go ` +
				`NOW — once the ceiling hits, every paid forge generation and x402 payment fails closed.`,
		};
	}
	if (projected >= REDIS_WARN_PROJECTED) {
		return {
			level: 'warning',
			title: 'Redis quota warning',
			message:
				`⚠️ Redis on track to exceed quota: ${k}k/500k requests this month. ` +
				`Upgrade the Upstash plan to prevent a forge outage.`,
		};
	}
	return null;
}

/**
 * Convenience: fetch + classify in one call, for the health endpoint.
 * @returns {Promise<RedisBurn>}
 */
export async function getRedisBurn() {
	return evaluateRedisBurn(await fetchRedisDailyCommands());
}

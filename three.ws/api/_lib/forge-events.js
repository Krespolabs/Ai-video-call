// Forge generation observability — fail-open structured logs + rolling counters.
//
// Under an influx you have to be able to SEE the pipeline: success rate, latency,
// and which backend is carrying the load. This module records every terminal
// generation outcome two ways:
//   1. One structured JSON log line per event — ALWAYS on, zero infra. Vercel log
//      drains / any aggregator can query `evt:"forge_gen"` for live throughput,
//      per-backend failure spikes, and latency without a database.
//   2. Best-effort rolling counters in the shared Upstash Redis, bucketed by hour,
//      surfaced in /api/forge?health=1 so the health dashboard shows real success
//      rate + latency instead of just upstream auth probes.
//
// Both fail OPEN: a metrics hiccup must never affect a generation. This is
// instrumentation, not a gate. Never construct a Redis client here — use the
// shared singleton (redis.js); per-module clients caused the June 2026 quota
// blowout.

import { getRedis } from './redis.js';
import { backendCostClass } from './forge-tiers.js';

const redis = getRedis();

const METRICS_PREFIX = 'fc:metrics:';
const BUCKET_TTL_S = 26 * 3600; // keep ~26h so a 24h read always has full data
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 48;

// Epoch hour — the counter bucket granularity. Cheap to aggregate (≤48 HGETALLs)
// and fine-grained enough to watch a spike develop over an afternoon.
function hourBucket(ts = Date.now()) {
	return Math.floor(ts / 3_600_000);
}

// Record one generation event. `phase` is 'start' | 'done' | 'failed'. 'start'
// only logs (no counters — we count terminal outcomes, not attempts, so the
// success rate denominator is meaningful). latencyMs/cacheHit apply to 'done'.
// Returns a promise the async terminal writers already await; the Redis write is
// a single pipelined round-trip, so awaiting adds negligible latency and makes
// the counter durable (an un-awaited promise can be frozen by the serverless
// runtime before it flushes).
export async function recordGenerationEvent({
	phase,
	backend = 'unknown',
	tier = null,
	path = null,
	latencyMs = null,
	cacheHit = false,
	source = null,
	errorCode = null,
} = {}) {
	// 1) Structured log line — unconditional, must never throw.
	try {
		console.log(
			JSON.stringify({
				evt: 'forge_gen',
				phase,
				backend,
				tier,
				path,
				latency_ms: typeof latencyMs === 'number' && latencyMs >= 0 ? Math.round(latencyMs) : null,
				cache_hit: Boolean(cacheHit),
				source,
				error_code: errorCode,
			}),
		);
	} catch {
		/* logging is best-effort */
	}

	// 2) Rolling counters — terminal phases only, best-effort.
	if (!redis || (phase !== 'done' && phase !== 'failed')) return;
	const ok = phase === 'done';
	const safeBackend = String(backend || 'unknown').replace(/[^a-z0-9_-]/gi, '') || 'unknown';
	const key = `${METRICS_PREFIX}${hourBucket()}`;
	const fields = {
		total: 1,
		[ok ? 'ok' : 'fail']: 1,
		[`b:${safeBackend}:total`]: 1,
		[`b:${safeBackend}:${ok ? 'ok' : 'fail'}`]: 1,
	};
	if (ok && typeof latencyMs === 'number' && latencyMs >= 0) {
		fields.lat_sum = Math.round(latencyMs);
		fields.lat_n = 1;
	}
	if (cacheHit) fields.cache_hit = 1;

	try {
		const pipe = redis.pipeline();
		for (const [field, by] of Object.entries(fields)) pipe.hincrby(key, field, by);
		pipe.expire(key, BUCKET_TTL_S);
		await pipe.exec();
	} catch {
		/* fail open — losing a counter never blocks a generation */
	}
}

// Aggregate the last `windowHours` hourly buckets into a single rollup for the
// health endpoint. Returns null when Redis is absent (the dashboard then simply
// omits the metrics block rather than showing zeros that look like an outage).
export async function readGenerationMetrics({ windowHours = DEFAULT_WINDOW_HOURS } = {}) {
	if (!redis) return null;
	const hours = Math.min(Math.max(Number(windowHours) || DEFAULT_WINDOW_HOURS, 1), MAX_WINDOW_HOURS);
	const now = hourBucket();
	const keys = [];
	for (let i = 0; i < hours; i += 1) keys.push(`${METRICS_PREFIX}${now - i}`);

	let buckets;
	try {
		buckets = await Promise.all(keys.map((k) => redis.hgetall(k).catch(() => null)));
	} catch {
		return null;
	}

	const agg = { total: 0, ok: 0, fail: 0, cache_hit: 0, lat_sum: 0, lat_n: 0, by_backend: {} };
	for (const bucket of buckets) {
		if (!bucket) continue;
		for (const [field, rawValue] of Object.entries(bucket)) {
			const value = Number(rawValue) || 0;
			if (field === 'total') agg.total += value;
			else if (field === 'ok') agg.ok += value;
			else if (field === 'fail') agg.fail += value;
			else if (field === 'cache_hit') agg.cache_hit += value;
			else if (field === 'lat_sum') agg.lat_sum += value;
			else if (field === 'lat_n') agg.lat_n += value;
			else if (field.startsWith('b:')) {
				const parts = field.split(':');
				const backend = parts[1];
				const kind = parts[2];
				if (!backend || !['total', 'ok', 'fail'].includes(kind)) continue;
				const slot = (agg.by_backend[backend] ||= { total: 0, ok: 0, fail: 0 });
				slot[kind] += value;
			}
		}
	}

	// Free-vs-paid serve split — the headline number for the self-host-first cost
	// goal: how many generations were served on a zero-vendor-cost lane (our own
	// GPU workers + free external previews) vs a paid one (Replicate platform
	// credits or a BYOK vendor key). Derived from the per-backend counters via the
	// registry's cost class, so it needs no extra counter writes and stays correct
	// as lanes are added. `unknown` collects any backend the registry no longer
	// knows (a renamed lane), surfaced rather than silently dropped.
	const byCost = {
		free: { total: 0, ok: 0, fail: 0 },
		paid: { total: 0, ok: 0, fail: 0 },
		unknown: { total: 0, ok: 0, fail: 0 },
	};
	for (const [backend, c] of Object.entries(agg.by_backend)) {
		const cls = backend === 'unknown' ? 'unknown' : backendCostClass(backend) || 'unknown';
		const slot = byCost[cls] || byCost.unknown;
		slot.total += c.total;
		slot.ok += c.ok;
		slot.fail += c.fail;
	}
	const servedTotal = byCost.free.total + byCost.paid.total;

	return {
		window_hours: hours,
		total: agg.total,
		ok: agg.ok,
		fail: agg.fail,
		cache_hits: agg.cache_hit,
		success_rate: agg.total > 0 ? Number((agg.ok / agg.total).toFixed(4)) : null,
		avg_latency_ms: agg.lat_n > 0 ? Math.round(agg.lat_sum / agg.lat_n) : null,
		by_backend: agg.by_backend,
		by_cost: byCost,
		// Share of generations that cost no vendor money — the metric the
		// self-host-first work is measured by. Null when nothing has been served yet.
		free_share: servedTotal > 0 ? Number((byCost.free.total / servedTotal).toFixed(4)) : null,
	};
}

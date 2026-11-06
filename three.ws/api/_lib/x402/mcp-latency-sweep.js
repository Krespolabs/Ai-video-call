// api/_lib/x402/mcp-latency-sweep.js
//
// MCP Tool Latency Monitor — the value-extraction stage of the
// `mcp-latency-monitor` autonomous-loop entry (autonomous-registry.js).
//
// The autonomous loop makes ONE real x402-paid call to /api/mcp every 5 minutes
// (the `validate_model` canary — see the registry entry). That paid round-trip
// is recorded to x402_autonomous_log like every other loop call. This module is
// the downstream "extract and store value" step: on each tick it sweeps the live
// MCP surface and records per-tool latency percentiles to `x402_perf_log`.
//
// Methodology (honest, no payment explosion, no side effects):
//   • Paid round-trip sample — the canary's full pay-and-settle latency, passed
//     in by the loop as ctx.durationMs. Series key: 'validate_model#paid'.
//   • tools/list discovery latency — one free probe. Series key: 'tools/list'.
//   • Per-tool first-response latency — for every advertised tool we send a
//     single unauthenticated, unpaid `tools/call` with minimal args and time the
//     round-trip to first response. This is exactly what an external agent
//     observes before it decides to pay: priced tools answer with a 402
//     challenge (pricing/auth path), the public getting_started tool executes,
//     OAuth-only tools answer with an auth error. All three are legitimate,
//     side-effect-free SLA samples of the caller-observed latency per tool.
//
// Percentiles (p50/p95/p99) are computed over a rolling 24h window of samples
// already in x402_perf_log, merged with the current tick's samples — so the
// store is the single source of truth and survives a Redis flush.
//
// SLA: any tool whose rolling p95 exceeds PERF_SLA_P95_MS is flagged
// (sla_breach=true on its row) and an alert is logged. The ops dashboard reads
// the breach state via GET /api/x402/mcp-perf.

import { sql } from '../db.js';
import { logger } from '../usage.js';

const log = logger('mcp-latency-sweep');

// SLA threshold: a tool whose rolling p95 first-response latency exceeds this is
// considered unhealthy and triggers an alert.
export const PERF_SLA_P95_MS = Number(process.env.MCP_PERF_SLA_P95_MS || 2000);

// Rolling window for percentile computation.
const WINDOW_HOURS = 24;
// Per-probe timeout — a hung tool counts as a large sample (a breach), not an
// infinite hang that stalls the cron tick.
const PROBE_TIMEOUT_MS = 6000;
// Bounded concurrency for the per-tool sweep so we don't open 35 sockets at once.
const PROBE_CONCURRENCY = 6;

let schemaReady = false;

export async function ensurePerfSchema() {
	if (schemaReady) return;
	try {
		await sql`
			CREATE TABLE IF NOT EXISTS x402_perf_log (
				id            bigserial PRIMARY KEY,
				ts            timestamptz NOT NULL DEFAULT now(),
				run_id        uuid,
				tool_name     text NOT NULL,
				endpoint      text NOT NULL DEFAULT '/api/mcp',
				sample_ms     int  NOT NULL,
				observed_status text,
				priced        boolean NOT NULL DEFAULT false,
				p50_ms        int,
				p95_ms        int,
				p99_ms        int,
				sample_count  int,
				sla_breach    boolean NOT NULL DEFAULT false,
				error         text
			)
		`;
		await sql`CREATE INDEX IF NOT EXISTS x402_perf_log_tool_ts_idx ON x402_perf_log (tool_name, ts DESC)`;
		schemaReady = true;
	} catch (err) {
		// Non-fatal: a migration system or a concurrent loop may own the table.
		if (!/already exists/i.test(err?.message || '')) {
			log.warn('perf_schema_failed', { message: err?.message });
		}
		schemaReady = true;
	}
}

// percentile of a numeric array using the nearest-rank method.
function percentile(sortedAsc, p) {
	if (!sortedAsc.length) return null;
	const rank = Math.ceil((p / 100) * sortedAsc.length);
	const idx = Math.min(Math.max(rank, 1), sortedAsc.length) - 1;
	return Math.round(sortedAsc[idx]);
}

async function fetchWithTimeout(url, opts = {}) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
	try {
		return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'manual' });
	} finally {
		clearTimeout(t);
	}
}

// List the advertised MCP tools via the free tools/list discovery call.
// Returns { tools: [{ name, priced }], listMs, error }.
async function listTools(origin) {
	const url = `${origin}/api/mcp`;
	const t0 = Date.now();
	try {
		const res = await fetchWithTimeout(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'user-agent': 'threews-mcp-latency/1.0' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }),
		});
		const listMs = Date.now() - t0;
		let body = null;
		try { body = await res.json(); } catch { body = null; }
		const tools = (body?.result?.tools || []).map((t) => ({
			name: t.name,
			priced: !!t.pricing,
		}));
		return { tools, listMs, error: tools.length ? null : 'empty_catalog' };
	} catch (err) {
		return { tools: [], listMs: Date.now() - t0, error: err?.message || 'list_failed' };
	}
}

// Probe one tool with an unpaid, unauthenticated tools/call and time the
// caller-observed first response. Never throws — failures become samples.
async function probeTool(origin, tool) {
	const url = `${origin}/api/mcp`;
	const t0 = Date.now();
	try {
		const res = await fetchWithTimeout(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'user-agent': 'threews-mcp-latency/1.0' },
			body: JSON.stringify({
				jsonrpc: '2.0', id: 'probe', method: 'tools/call',
				params: { name: tool.name, arguments: {} },
			}),
		});
		// Drain the body so the connection can close and the timing reflects a
		// complete response, not just headers.
		try { await res.text(); } catch { /* ignore */ }
		return {
			tool: tool.name,
			sampleMs: Date.now() - t0,
			status: String(res.status),
			priced: tool.priced,
			error: null,
		};
	} catch (err) {
		const aborted = err?.name === 'AbortError';
		return {
			tool: tool.name,
			sampleMs: aborted ? PROBE_TIMEOUT_MS : Date.now() - t0,
			status: aborted ? 'timeout' : 'error',
			priced: tool.priced,
			error: aborted ? `timeout_${PROBE_TIMEOUT_MS}ms` : (err?.message || 'probe_failed'),
		};
	}
}

// Run probes with bounded concurrency.
async function probeAll(origin, tools) {
	const out = [];
	let i = 0;
	async function worker() {
		while (i < tools.length) {
			const tool = tools[i++];
			out.push(await probeTool(origin, tool));
		}
	}
	await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, tools.length) }, worker));
	return out;
}

/**
 * Run the full latency sweep and persist per-tool percentiles to x402_perf_log.
 * Called by the autonomous loop as the `persist` hook of the mcp-latency-monitor
 * entry. Never throws — every failure is caught, logged, and recorded.
 *
 * @param {object} ctx
 * @param {string} ctx.runId      loop run id (FK into x402_autonomous_log)
 * @param {string} ctx.origin     origin to probe (e.g. https://three.ws)
 * @param {number} ctx.durationMs canary paid round-trip latency
 * @param {boolean} ctx.success   whether the canary call settled
 * @param {object} [ctx.responseBody] canary JSON-RPC response (for sanity)
 * @returns {Promise<object>} summary { tools, breaches, alerted }
 */
export async function mcpLatencySweep(ctx = {}) {
	const { runId = null, origin, durationMs = 0, success = false } = ctx;
	if (!origin) {
		log.warn('sweep_no_origin', { runId });
		return { tools: 0, breaches: 0, alerted: false, skipped: 'no_origin' };
	}

	await ensurePerfSchema();

	// 1. Enumerate the live tool catalog (free discovery).
	const { tools, listMs, error: listError } = await listTools(origin);

	// 2. Assemble this tick's raw samples.
	//    a) canary paid round-trip (the one real x402 payment of this entry)
	//    b) tools/list discovery latency
	//    c) per-tool unpaid first-response latency
	const samples = [];
	if (success && durationMs > 0) {
		samples.push({ tool: 'validate_model#paid', sampleMs: durationMs, status: 'paid', priced: true, error: null });
	}
	samples.push({ tool: 'tools/list', sampleMs: listMs, status: listError ? 'error' : '200', priced: false, error: listError });

	const probed = tools.length ? await probeAll(origin, tools) : [];
	samples.push(...probed);

	if (!samples.length) {
		log.warn('sweep_no_samples', { runId, listError });
		return { tools: 0, breaches: 0, alerted: false, skipped: 'no_samples' };
	}

	// 3. Pull the rolling window from the store and compute percentiles per tool,
	//    including this tick's fresh samples.
	const history = new Map(); // tool -> number[]
	try {
		const rows = await sql`
			SELECT tool_name, sample_ms
			FROM x402_perf_log
			WHERE ts > now() - make_interval(hours => ${WINDOW_HOURS})
		`;
		for (const r of rows) {
			const arr = history.get(r.tool_name) || [];
			arr.push(Number(r.sample_ms));
			history.set(r.tool_name, arr);
		}
	} catch (err) {
		// First run (table absent) or read failure — fall back to current samples
		// only. The sweep still records this tick.
		if (!/does not exist/i.test(err?.message || '')) {
			log.warn('perf_history_read_failed', { message: err?.message });
		}
	}

	const breaches = [];
	const rowsToInsert = samples.map((s) => {
		const merged = (history.get(s.tool) || []).concat([s.sampleMs]).sort((a, b) => a - b);
		const p50 = percentile(merged, 50);
		const p95 = percentile(merged, 95);
		const p99 = percentile(merged, 99);
		const breach = p95 != null && p95 > PERF_SLA_P95_MS;
		if (breach) breaches.push({ tool: s.tool, p95, samples: merged.length });
		return { ...s, p50, p95, p99, count: merged.length, breach };
	});

	// 4. Persist every sample row. Insert failures are caught per-row so one bad
	//    row never drops the rest.
	let inserted = 0;
	await Promise.all(rowsToInsert.map(async (r) => {
		try {
			await sql`
				INSERT INTO x402_perf_log
					(run_id, tool_name, endpoint, sample_ms, observed_status, priced,
					 p50_ms, p95_ms, p99_ms, sample_count, sla_breach, error)
				VALUES
					(${runId}, ${r.tool}, ${'/api/mcp'}, ${r.sampleMs}, ${r.status}, ${r.priced},
					 ${r.p50}, ${r.p95}, ${r.p99}, ${r.count}, ${r.breach}, ${r.error || null})
			`;
			inserted++;
		} catch (err) {
			log.warn('perf_insert_failed', { tool: r.tool, message: err?.message });
		}
	}));

	// 5. Alert on SLA breaches.
	const alerted = breaches.length > 0;
	if (alerted) {
		log.warn('mcp_sla_breach', {
			run_id: runId,
			threshold_ms: PERF_SLA_P95_MS,
			breached: breaches.map((b) => `${b.tool}:p95=${b.p95}ms`),
		});
	}

	log.info('mcp_latency_sweep_complete', {
		run_id: runId,
		tools: tools.length,
		samples: samples.length,
		inserted,
		breaches: breaches.length,
		list_ms: listMs,
		canary_ms: success ? durationMs : null,
	});

	return { tools: tools.length, samples: samples.length, inserted, breaches: breaches.length, alerted };
}

/**
 * Dashboard / downstream read: latest per-tool SLA health from x402_perf_log.
 * Consumed by GET /api/x402/mcp-perf.
 * @returns {Promise<{ ok, healthy, sla_p95_ms, tools, breaches, generated_at }>}
 */
export async function readPerfHealth({ windowHours = WINDOW_HOURS } = {}) {
	await ensurePerfSchema();
	const hours = Math.max(1, Math.floor(Number(windowHours) || WINDOW_HOURS));
	// Latest row per tool (most recent percentile snapshot).
	const rows = await sql`
		SELECT DISTINCT ON (tool_name)
			tool_name, ts, sample_ms, observed_status, priced,
			p50_ms, p95_ms, p99_ms, sample_count, sla_breach, error
		FROM x402_perf_log
		WHERE ts > now() - make_interval(hours => ${hours})
		ORDER BY tool_name, ts DESC
	`;
	const tools = rows.map((r) => ({
		tool: r.tool_name,
		last_ms: Number(r.sample_ms),
		status: r.observed_status,
		priced: r.priced,
		p50_ms: r.p50_ms,
		p95_ms: r.p95_ms,
		p99_ms: r.p99_ms,
		samples: r.sample_count,
		sla_breach: r.sla_breach,
		error: r.error,
		updated_at: r.ts,
	}));
	const breaches = tools.filter((t) => t.sla_breach);
	return {
		ok: true,
		healthy: breaches.length === 0,
		sla_p95_ms: PERF_SLA_P95_MS,
		window_hours: hours,
		tool_count: tools.length,
		breach_count: breaches.length,
		breaches: breaches.map((b) => ({ tool: b.tool, p95_ms: b.p95_ms, samples: b.samples })),
		tools,
	};
}

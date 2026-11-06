// GET /api/x402/mcp-perf — MCP Tool Latency Monitor SLA dashboard feed.
//
// Free operational read (parity with /api/x402-status): surfaces the live SLA
// health of the three.ws MCP server as measured by the `mcp-latency-monitor`
// autonomous-loop entry (api/_lib/x402/autonomous-registry.js). That loop pays a
// real x402 canary call to /api/mcp every 5 minutes and sweeps every advertised
// tool, writing rolling p50/p95/p99 latencies to x402_perf_log. This endpoint is
// the downstream consumer: it reads the latest percentile snapshot per tool and
// reports whether any tool breaches the p95 SLA.
//
// Query: ?window=<hours> (default 24, max 168) — the rolling window to report.

import { cors, json, method, wrap } from '../_lib/http.js';
import { readPerfHealth } from '../_lib/x402/mcp-latency-sweep.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	let windowHours = 24;
	try {
		const u = new URL(req.url, 'http://localhost');
		const w = Number(u.searchParams.get('window'));
		if (Number.isFinite(w) && w > 0) windowHours = Math.min(Math.max(w, 1), 168);
	} catch { /* default window */ }

	try {
		const health = await readPerfHealth({ windowHours });
		// 200 always — the dashboard renders the breach state itself; a non-2xx
		// here would be indistinguishable from the endpoint being down.
		return json(res, 200, { ...health, generated_at: new Date().toISOString() });
	} catch (err) {
		// Table absent (loop never ran) or DB hiccup — report empty-but-healthy so
		// the dashboard shows "no data yet" instead of an error void.
		const noData = /does not exist/i.test(err?.message || '');
		return json(res, noData ? 200 : 503, {
			ok: noData,
			healthy: true,
			tool_count: 0,
			breach_count: 0,
			breaches: [],
			tools: [],
			note: noData ? 'no_samples_yet' : undefined,
			error: noData ? undefined : 'perf_read_failed',
			generated_at: new Date().toISOString(),
		});
	}
});

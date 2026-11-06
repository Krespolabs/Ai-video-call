// GET /api/x402/glb-optimization-report — GLB Size Optimizer catalog feed.
//
// Free operational read (parity with /api/x402/mcp-perf): surfaces what the
// `glb-size-optimizer` autonomous-loop entry (api/_lib/x402/autonomous-registry.js)
// has measured. That loop pays a real x402 optimize_model call against /api/mcp
// every 6 hours for the heaviest un-analyzed public GLB over the 5 MB budget,
// then writes the original size, projected post-optimization size, and load-time
// improvement to glb_optimizations. This endpoint is the downstream consumer: it
// reports the catalog-wide average savings + load-time improvement, the total
// bytes the catalog would shed, and the remaining backlog of heavy GLBs.
//
// Query: ?window=<days> (default 90, max 365) — the rolling analysis window.

import { cors, json, method, wrap } from '../_lib/http.js';
import { readCatalogOptimizationSummary } from '../_lib/x402/glb-size-optimizer.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	let windowDays = 90;
	try {
		const u = new URL(req.url, 'http://localhost');
		const w = Number(u.searchParams.get('window'));
		if (Number.isFinite(w) && w > 0) windowDays = Math.min(Math.max(w, 1), 365);
	} catch { /* default window */ }

	try {
		const summary = await readCatalogOptimizationSummary({ windowDays });
		// 200 always — the dashboard renders the state itself; a non-2xx here would
		// be indistinguishable from the endpoint being down.
		return json(res, 200, { ...summary, generated_at: new Date().toISOString() });
	} catch (err) {
		// Table absent (loop never ran) or DB hiccup — report empty-but-ok so the
		// dashboard shows "no data yet" instead of an error void.
		const noData = /does not exist/i.test(err?.message || '');
		return json(res, noData ? 200 : 503, {
			ok: noData,
			window_days: windowDays,
			analyzed_count: 0,
			backlog_count: 0,
			total_savings_bytes: 0,
			total_savings_mb: 0,
			avg_savings_pct: 0,
			avg_load_improvement_pct: 0,
			models: [],
			note: noData ? 'no_optimizations_yet' : undefined,
			error: noData ? undefined : 'report_read_failed',
			generated_at: new Date().toISOString(),
		});
	}
});

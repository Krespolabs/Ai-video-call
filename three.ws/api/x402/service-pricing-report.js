// GET /api/x402/service-pricing-report — x402 Service Pricing Tracker feed.
//
// Free operational read (parity with /api/x402/glb-optimization-report and
// /api/x402/mcp-perf): surfaces what the `x402-pricing-tracker` autonomous-loop
// entry (api/_lib/x402/autonomous-registry.js) has measured. That loop pays a
// real $0.001 x402 call to /api/mcp-bazaar (bazaar_service_details) for the
// stalest tracked external services every 6 hours and records each one's current
// live cheapest price, the change vs the last check, and alert state into
// x402_service_price_current. This endpoint is the downstream consumer: it
// reports the full tracked catalog, the active price-increase alerts (cost-model
// action items: a dependency raised its price > 20%), and the price-drop
// opportunities (a dependency got cheaper — lean on it more).
//
// Query: ?limit=<n> (default 200, max 500) — cap on tracked services returned.

import { cors, json, method, wrap } from '../_lib/http.js';
import { readPricingReport } from '../_lib/x402/pipelines/x402-pricing-tracker.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	let limit = 200;
	try {
		const u = new URL(req.url, 'http://localhost');
		const n = Number(u.searchParams.get('limit'));
		if (Number.isFinite(n) && n > 0) limit = Math.min(Math.max(n, 1), 500);
	} catch { /* default limit */ }

	try {
		const report = await readPricingReport({ limit });
		// 200 always — the dashboard renders the state itself; a non-2xx here would
		// be indistinguishable from the endpoint being down.
		return json(res, 200, { ...report, generated_at: new Date().toISOString() });
	} catch (err) {
		// Table absent (loop never ran) or DB hiccup — report empty-but-ok so the
		// dashboard shows "no data yet" instead of an error void.
		const noData = /does not exist/i.test(err?.message || '');
		return json(res, noData ? 200 : 503, {
			ok: noData,
			tracked_count: 0,
			alert_count: 0,
			opportunity_count: 0,
			unavailable_count: 0,
			services: [],
			alerts: [],
			opportunities: [],
			generated_at: new Date().toISOString(),
			...(noData ? {} : { error: 'pricing_report_unavailable' }),
		});
	}
});

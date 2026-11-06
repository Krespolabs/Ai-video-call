// GET /api/x402/network-cost — Cross-Chain Payment Cost recommendation feed.
//
// Free operational read (parity with /api/x402-status): surfaces the live cost
// of settling an identical $0.001 USDC payment on Solana vs Base, as measured by
// the `cross-chain-cost-comparison` autonomous-loop entry
// (api/_lib/x402/pipelines/cross-chain-cost.js). That loop hourly settles the
// real Solana leg, reads its on-chain fee, prices the equivalent Base settlement
// from the live Base gas price, and writes a snapshot to
// cross_chain_cost_comparison. This endpoint is the downstream consumer: it
// returns the latest snapshot, a rolling gas-premium average over the requested
// window, and the recommended (cheapest) settlement network so the app can steer
// users to the cheaper rail and inform default-network pricing.
//
// Query: ?window=<hours> (default 168, max 720) — the rolling stats window.

import { cors, json, method, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	let windowHours = 168;
	try {
		const u = new URL(req.url, 'http://localhost');
		const w = Number(u.searchParams.get('window'));
		if (Number.isFinite(w) && w > 0) windowHours = Math.min(Math.max(w, 1), 720);
	} catch { /* default window */ }

	try {
		const latestRows = await sql`
			SELECT * FROM cross_chain_cost_comparison
			ORDER BY checked_at DESC
			LIMIT 1
		`;
		const latest = latestRows[0] || null;

		const stats = await sql`
			SELECT
				count(*)                                              AS samples,
				avg(gas_premium_ratio)  FILTER (WHERE gas_premium_ratio IS NOT NULL) AS avg_gas_premium_ratio,
				avg(solana_gas_usd)     FILTER (WHERE solana_gas_usd  IS NOT NULL)    AS avg_solana_gas_usd,
				avg(base_gas_usd)       FILTER (WHERE base_gas_usd    IS NOT NULL)    AS avg_base_gas_usd,
				count(*) FILTER (WHERE cheapest_network = 'solana')   AS solana_wins,
				count(*) FILTER (WHERE cheapest_network = 'base')     AS base_wins
			FROM cross_chain_cost_comparison
			WHERE checked_at >= now() - (${windowHours} || ' hours')::interval
		`;
		const s = stats[0] || {};

		const num = (v) => (v == null ? null : Number(v));
		const samples = Number(s.samples || 0);

		// The recommendation: the latest snapshot's cheapest network is authoritative
		// (it reflects current gas), backed by the window's win-count majority.
		const recommended = latest?.cheapest_network
			|| (Number(s.base_wins || 0) > Number(s.solana_wins || 0) ? 'base' : 'solana');

		return json(res, 200, {
			ok: true,
			recommended_network: samples > 0 ? recommended : null,
			latest: latest
				? {
					checked_at: latest.checked_at,
					amount_usd: num(latest.amount_usd),
					solana: {
						advertised: latest.solana_advertised,
						settled: latest.solana_settled,
						gas_usd: num(latest.solana_gas_usd),
						total_usd: num(latest.solana_total_usd),
						fee_lamports: latest.solana_fee_lamports != null ? Number(latest.solana_fee_lamports) : null,
						fee_source: latest.solana_fee_source,
						tx: latest.solana_tx,
					},
					base: {
						advertised: latest.base_advertised,
						gas_usd: num(latest.base_gas_usd),
						total_usd: num(latest.base_total_usd),
						gas_price_gwei: latest.base_gas_price_wei != null ? Number(latest.base_gas_price_wei) / 1e9 : null,
						gas_units: latest.base_gas_units != null ? Number(latest.base_gas_units) : null,
						settled: false, // no autonomous EVM payer — gas is priced from live network data
					},
					gas_premium_ratio: num(latest.gas_premium_ratio),
					cheapest_network: latest.cheapest_network,
					sol_price_usd: num(latest.sol_price_usd),
					eth_price_usd: num(latest.eth_price_usd),
				}
				: null,
			window_hours: windowHours,
			rolling: {
				samples,
				avg_gas_premium_ratio: num(s.avg_gas_premium_ratio),
				avg_solana_gas_usd: num(s.avg_solana_gas_usd),
				avg_base_gas_usd: num(s.avg_base_gas_usd),
				solana_cheapest_count: Number(s.solana_wins || 0),
				base_cheapest_count: Number(s.base_wins || 0),
			},
			generated_at: new Date().toISOString(),
		});
	} catch (err) {
		// Table absent (loop never ran) or DB hiccup — report empty-but-ok so the
		// dashboard shows "no data yet" instead of an error void.
		const noData = /does not exist/i.test(err?.message || '');
		return json(res, noData ? 200 : 503, {
			ok: noData,
			recommended_network: null,
			latest: null,
			rolling: { samples: 0 },
			note: noData ? 'no_samples_yet' : undefined,
			error: noData ? undefined : 'network_cost_read_failed',
			generated_at: new Date().toISOString(),
		});
	}
});

// api/_lib/x402/pipelines/x402-pricing-tracker.js
//
// x402 Service Pricing Tracker — autonomous pipeline (self).
//
// Tracks the price history of the external x402 services three.ws depends on so
// our cost models stay honest. On each run it picks the stalest batch of tracked
// services and, for each, pays a real on-chain $0.001 USDC call to the three.ws
// x402 Bazaar MCP server (/api/mcp-bazaar → bazaar_service_details) to read that
// service's *current live* price across networks. It compares the fresh price to
// the last recorded one and:
//   • raises a PRICE INCREASE alert when a service's cheapest price jumped > 20%
//     (so we revisit our cost models / consider an alternative), and
//   • flags a PRICE DROP opportunity when it fell enough (≤ -15%) that we should
//     lean on the service more.
//
// The pipeline:
//   1. Builds the tracked-service set from the live, priced resources the Bazaar
//      Discovery Warmup (self/008) snapshots into x402_bazaar_catalog — i.e. the
//      external services we have actually discovered and depend on. No hardcoded
//      service list; coverage grows with what the warmup finds.
//   2. Probes + pays bazaar_service_details for the stalest BATCH services (real
//      x402; degrades gracefully when the wallet/RPC is unconfigured or a single
//      call fails — never crashes the loop).
//   3. Appends a row per check to x402_service_price_history and upserts the
//      latest snapshot (+ change math + alert flags) into x402_service_price_current.
//   4. Records one row per call in x402_autonomous_log (success OR failure), with
//      the price + change summary in value_extracted.
//
// Downstream consumer: GET /api/x402/service-pricing-report reads
// x402_service_price_current to surface the tracked catalog, the active
// price-increase alerts (cost-model action items), and the price-drop
// opportunities. The same table is the source of truth for revisiting the unit
// economics behind our own pricing.
//
// Real on-chain payments only — no mocks, no simulations.

import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { solanaConnection } from '../../solana/connection.js';
import { logger } from '../../usage.js';
import { loadSeedKeypair, payX402 } from '../pay.js';

const log = logger('x402-pricing-tracker');

const USDC_MINT = () => env.X402_ASSET_MINT_SOLANA || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// How many tracked services to re-price per run. With the registry's 6h cooldown
// this rotates through the tracked set a few at a time while bounding spend
// (≤ BATCH × $0.001 per run). A catalog of ~20 services is fully refreshed ≈ daily.
const BATCH = Math.max(1, Number(process.env.X402_PRICING_TRACKER_BATCH || 5));

// Price-change thresholds. A cheapest-price jump above this fraction trips a
// cost-model alert; a drop at/below the negative threshold flags an opportunity.
const INCREASE_ALERT_PCT = Number(process.env.X402_PRICING_INCREASE_PCT || 20);
const DROP_OPPORTUNITY_PCT = Number(process.env.X402_PRICING_DROP_PCT || 15);

// ── Schema ──────────────────────────────────────────────────────────────────
let _schemaReady = false;
async function ensureSchema() {
	if (_schemaReady) return;
	// Append-only price observations — one row per check. The time series behind
	// any trend/sparkline view of a dependency's price.
	await sql`
		CREATE TABLE IF NOT EXISTS x402_service_price_history (
			id                bigserial PRIMARY KEY,
			run_id            uuid,
			ts                timestamptz DEFAULT now(),
			service_key       text NOT NULL,
			resource          text NOT NULL,
			tool_name         text,
			name              text,
			network           text,
			price_atomic      bigint,
			price_label       text,
			asset             text,
			available         boolean NOT NULL DEFAULT true,
			prev_price_atomic bigint,
			pct_change        numeric(10,2)
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS x402_service_price_history_key_ts ON x402_service_price_history (service_key, ts DESC)`;

	// Latest snapshot per tracked service + the derived alert state. This is the
	// row the report endpoint and cost-model review read.
	await sql`
		CREATE TABLE IF NOT EXISTS x402_service_price_current (
			service_key            text PRIMARY KEY,
			resource               text NOT NULL,
			tool_name              text,
			name                   text,
			network                text,
			price_atomic           bigint,
			price_label            text,
			asset                  text,
			available              boolean NOT NULL DEFAULT true,
			prev_price_atomic      bigint,
			pct_change             numeric(10,2),
			price_increase_alert   boolean NOT NULL DEFAULT false,
			price_drop_opportunity boolean NOT NULL DEFAULT false,
			checks                 int NOT NULL DEFAULT 0,
			first_seen             timestamptz DEFAULT now(),
			last_checked           timestamptz DEFAULT now(),
			run_id                 uuid
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS x402_service_price_current_alert ON x402_service_price_current (price_increase_alert) WHERE price_increase_alert`;
	// Shared autonomous-log value column (idempotent — other pipelines add it too).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

// ── Tracked-service selection ────────────────────────────────────────────────
// The services we depend on are exactly the live, priced resources the Bazaar
// Discovery Warmup snapshots. Flatten the most recent snapshot per category into
// a deduped set, then sort stalest-first (never-checked first) using the
// last_checked timestamp from x402_service_price_current so coverage rotates.
async function selectTrackedServices(limit) {
	let catalogRows;
	try {
		catalogRows = await sql`
			SELECT DISTINCT ON (category) category, resources
			FROM x402_bazaar_catalog
			ORDER BY category, ts DESC
		`;
	} catch (err) {
		// Warmup hasn't run yet (table absent) — nothing to track this run.
		if (/does not exist/i.test(err?.message || '')) return [];
		throw err;
	}

	const byKey = new Map();
	for (const row of catalogRows) {
		const resources = Array.isArray(row.resources) ? row.resources : [];
		for (const s of resources) {
			if (!s || !s.resource) continue;
			const key = s.key || (s.tool_name ? `${s.resource}#${s.tool_name}` : s.resource);
			if (!byKey.has(key)) {
				byKey.set(key, {
					service_key: key,
					resource: s.resource,
					tool_name: s.tool_name || null,
					networks: Array.isArray(s.networks) ? s.networks : [],
				});
			}
		}
	}
	if (byKey.size === 0) return [];

	// Pull last_checked for everything we've already tracked so we can prioritise
	// the stalest. Unknown (never-tracked) services sort first (null last_checked).
	const lastChecked = new Map();
	try {
		const rows = await sql`SELECT service_key, last_checked FROM x402_service_price_current`;
		for (const r of rows) lastChecked.set(r.service_key, r.last_checked);
	} catch { /* table may not exist on a cold first run — treat all as never-checked */ }

	return [...byKey.values()]
		.sort((a, b) => {
			const ta = lastChecked.get(a.service_key);
			const tb = lastChecked.get(b.service_key);
			if (!ta && tb) return -1;
			if (ta && !tb) return 1;
			if (!ta && !tb) return 0;
			return new Date(ta).getTime() - new Date(tb).getTime();
		})
		.slice(0, limit);
}

// ── bazaar_service_details call + parse ──────────────────────────────────────
function detailsBody(resource, toolName, id) {
	return {
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: {
			name: 'bazaar_service_details',
			arguments: { resource_url: resource, ...(toolName ? { tool_name: toolName } : {}) },
		},
	};
}

// Pull the bazaar_service_details structuredContent out of a JSON-RPC response.
export function extractDetails(responseBody) {
	const rpcError = responseBody?.error || responseBody?.result?.isError || null;
	const sc = responseBody?.result?.structuredContent;
	if (!sc || typeof sc !== 'object') return { details: null, rpcError };
	return { details: sc, rpcError };
}

// Derive a comparable price record from the details payload. The tracked figure
// is the cheapest price across all networks (min_price_atomic) — that's the
// number a cost model uses and the one a hike/drop is measured against.
export function priceRecordFromDetails(details, fallback) {
	const available = details?.available !== false;
	const prices = Array.isArray(details?.prices) ? details.prices : [];
	let minAtomic = details?.min_price_atomic != null ? Number(details.min_price_atomic) : null;
	let minNetwork = null;
	let minLabel = details?.min_price_label || null;
	let asset = null;
	// Resolve the network/asset that carries the cheapest price for context.
	for (const p of prices) {
		const a = p?.amount_atomic != null ? Number(p.amount_atomic) : null;
		if (a == null || !Number.isFinite(a)) continue;
		if (minAtomic == null || a < minAtomic) {
			minAtomic = a;
			minNetwork = p.network || null;
			minLabel = p.price || minLabel;
			asset = p.asset || null;
		} else if (a === minAtomic && minNetwork == null) {
			minNetwork = p.network || null;
			asset = p.asset || asset;
		}
	}
	return {
		service_key: details?.service_key || fallback.service_key,
		resource: details?.resource || fallback.resource,
		tool_name: details?.tool_name || fallback.tool_name || null,
		name: details?.name || null,
		network: minNetwork,
		price_atomic: Number.isFinite(minAtomic) ? minAtomic : null,
		price_label: minLabel,
		asset,
		available,
	};
}

// Percentage change of cur vs prev (cheapest atomic price). Null when there's no
// comparable baseline (first observation, or either side unpriced/unavailable).
export function pctChange(prev, cur) {
	if (prev == null || cur == null || prev <= 0) return null;
	return Number((((cur - prev) / prev) * 100).toFixed(2));
}

async function recordCall(runId, { serviceName, endpointUrl, amountAtomic, txSig, responseData, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${serviceName}, ${endpointUrl},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${USDC_MINT()}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'discovery'})
		`;
	} catch (err) {
		log.warn('pricing_tracker_log_insert_failed', { message: err?.message });
	}
}

// Persist one observation: append to history, upsert the current snapshot, and
// return the derived change/alert state for the log row.
async function persistObservation(runId, tracked, record) {
	// Prior cheapest price for this service (the last current snapshot).
	let prevAtomic = null;
	try {
		const [prev] = await sql`
			SELECT price_atomic FROM x402_service_price_current WHERE service_key = ${record.service_key}
		`;
		prevAtomic = prev?.price_atomic != null ? Number(prev.price_atomic) : null;
	} catch { /* table absent on cold start — no baseline */ }

	const change = record.available ? pctChange(prevAtomic, record.price_atomic) : null;
	const increaseAlert = change != null && change > INCREASE_ALERT_PCT;
	const dropOpportunity = change != null && change <= -DROP_OPPORTUNITY_PCT;

	await sql`
		INSERT INTO x402_service_price_history
			(run_id, service_key, resource, tool_name, name, network,
			 price_atomic, price_label, asset, available, prev_price_atomic, pct_change)
		VALUES
			(${runId}, ${record.service_key}, ${record.resource}, ${record.tool_name}, ${record.name},
			 ${record.network}, ${record.price_atomic}, ${record.price_label}, ${record.asset},
			 ${record.available}, ${prevAtomic}, ${change})
	`;

	await sql`
		INSERT INTO x402_service_price_current
			(service_key, resource, tool_name, name, network, price_atomic, price_label,
			 asset, available, prev_price_atomic, pct_change, price_increase_alert,
			 price_drop_opportunity, checks, first_seen, last_checked, run_id)
		VALUES
			(${record.service_key}, ${record.resource}, ${record.tool_name}, ${record.name},
			 ${record.network}, ${record.price_atomic}, ${record.price_label}, ${record.asset},
			 ${record.available}, ${prevAtomic}, ${change}, ${increaseAlert},
			 ${dropOpportunity}, ${1}, now(), now(), ${runId})
		ON CONFLICT (service_key) DO UPDATE SET
			resource               = EXCLUDED.resource,
			tool_name              = EXCLUDED.tool_name,
			name                   = COALESCE(EXCLUDED.name, x402_service_price_current.name),
			network                = EXCLUDED.network,
			prev_price_atomic      = x402_service_price_current.price_atomic,
			price_atomic           = EXCLUDED.price_atomic,
			price_label            = EXCLUDED.price_label,
			asset                  = EXCLUDED.asset,
			available              = EXCLUDED.available,
			pct_change             = EXCLUDED.pct_change,
			price_increase_alert   = EXCLUDED.price_increase_alert,
			price_drop_opportunity = EXCLUDED.price_drop_opportunity,
			checks                 = x402_service_price_current.checks + 1,
			last_checked           = now(),
			run_id                 = EXCLUDED.run_id
	`;

	return { prevAtomic, change, increaseAlert, dropOpportunity };
}

// Surface a price hike to ops: a log warning + a short-lived Redis flag the
// status surface can poll. Best-effort — never throws into the loop.
async function raisePriceAlert(redis, record, change) {
	log.warn('x402_price_increase_alert', {
		service_key: record.service_key,
		resource: record.resource,
		tool_name: record.tool_name,
		price_atomic: record.price_atomic,
		pct_change: change,
	});
	if (!redis) return;
	try {
		await redis.set(
			`x402:price-alert:${record.service_key}`,
			JSON.stringify({ price_atomic: record.price_atomic, pct_change: change, ts: Date.now() }),
			{ ex: 7 * 86400 },
		);
	} catch { /* non-fatal */ }
}

/**
 * Run the tracker. Self-contained: reuses the loop's Solana context when given,
 * else bootstraps its own so it can be invoked directly (manual test). Records
 * its own per-call log rows, so it returns { recorded: true } and the loop skips
 * its generic summary row.
 *
 * @param {object} [ctx] loop context: { runId, origin, buyer, conn, blockhash, mintInfo, redis, remainingCap }
 * @returns {Promise<object>} loop-compatible outcome
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const endpointUrl = `${origin}/api/mcp-bazaar`;
	const redis = ctx.redis || null;
	const usdcMint = USDC_MINT();
	let remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;

	const fail = (reason, extra = {}) => ({
		ok: false, recorded: true, skipped: true, success: false,
		amountAtomic: 0, txSig: null, note: reason, ...extra,
	});

	// ── Wallet pre-flight: exit gracefully (logged) if unconfigured ───────────
	let buyer = ctx.buyer;
	if (!buyer) {
		try { buyer = loadSeedKeypair(); } catch (err) {
			log.info('pricing_tracker_skipped', { reason: err.message });
			return fail(err.message);
		}
	}

	try {
		await ensureSchema();
	} catch (err) {
		log.warn('pricing_tracker_schema_failed', { message: err?.message });
		return fail(`schema_failed: ${err?.message}`);
	}

	let tracked;
	try {
		tracked = await selectTrackedServices(BATCH);
	} catch (err) {
		log.warn('pricing_tracker_select_failed', { message: err?.message });
		return fail(`select_failed: ${err?.message}`);
	}
	if (!tracked.length) {
		// Nothing discovered to track yet — the Bazaar Discovery Warmup populates
		// x402_bazaar_catalog. Record a skip summary (loop adds the row).
		return { ok: true, recorded: false, skipped: true, success: true, amountAtomic: 0, txSig: null, note: 'no_tracked_services' };
	}

	// ── Solana payment context (reuse the loop's, else build our own) ─────────
	let conn = ctx.conn;
	let blockhash = ctx.blockhash;
	let mintInfo = ctx.mintInfo;
	if (!conn || !blockhash || !mintInfo) {
		try {
			conn = conn || solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
			const [bh, mi] = await Promise.all([
				blockhash ? Promise.resolve({ blockhash }) : conn.getLatestBlockhash('confirmed'),
				mintInfo ? Promise.resolve(mintInfo) : getMint(conn, new PublicKey(usdcMint)),
			]);
			blockhash = blockhash || bh.blockhash;
			mintInfo = mintInfo || mi;
		} catch (err) {
			log.warn('pricing_tracker_solana_preflight_failed', { message: err?.message });
			return fail(`solana_preflight_failed: ${err?.message}`);
		}
	}

	let spentAtomic = 0;
	let paid = 0;
	let checked = 0;
	let alerts = 0;
	let opportunities = 0;
	let lastTxSig = null;
	const summaries = [];

	for (let i = 0; i < tracked.length; i++) {
		if (remainingCap <= 0) {
			log.info('pricing_tracker_cap_reached', { spent_atomic: spentAtomic });
			break;
		}
		const t = tracked[i];
		const serviceName = `Price Tracker: ${t.tool_name ? `${t.resource}#${t.tool_name}` : t.resource}`;
		const t0 = Date.now();

		let result;
		try {
			result = await payX402({
				url: endpointUrl,
				method: 'POST',
				body: detailsBody(t.resource, t.tool_name, i + 1),
				conn, buyer, blockhash, mintInfo,
				remainingCap,
				// Distinct priority fee per call so several same-amount payments on the
				// one shared blockhash compile to distinct signatures.
				nonce: i + 1,
			});
		} catch (err) {
			await recordCall(runId, {
				serviceName, endpointUrl, amountAtomic: 0, txSig: null,
				responseData: { service_key: t.service_key },
				durationMs: Date.now() - t0, success: false,
				errorMsg: err?.message || 'fetch_failed', valueExtracted: null,
			});
			summaries.push({ service: t.service_key, error: err?.message || 'fetch_failed' });
			continue;
		}

		const statusLabel = result.paid ? 'paid' : result.free ? 'free' : result.skipped ? 'skip' : 'error';
		if (result.paid) {
			spentAtomic += result.amountAtomic;
			remainingCap -= result.amountAtomic;
			paid += 1;
			lastTxSig = result.txSig || lastTxSig;
		}

		const { details, rpcError } = extractDetails(result.responseBody);
		let valueExtracted = null;
		let errorMsg = result.errorMsg;

		if (result.success && details) {
			const record = priceRecordFromDetails(details, t);
			let change = null, increaseAlert = false, dropOpportunity = false;
			try {
				({ change, increaseAlert, dropOpportunity } = await persistObservation(runId, t, record));
				checked += 1;
			} catch (err) {
				errorMsg = `db_persist_failed: ${err?.message}`;
				log.warn('pricing_tracker_persist_failed', { service: t.service_key, message: err?.message });
			}
			if (increaseAlert) { alerts += 1; await raisePriceAlert(redis, record, change); }
			if (dropOpportunity) opportunities += 1;

			valueExtracted = {
				service_key: record.service_key,
				price_atomic: record.price_atomic,
				price_label: record.price_label,
				network: record.network,
				available: record.available,
				pct_change: change,
				price_increase_alert: increaseAlert,
				price_drop_opportunity: dropOpportunity,
			};
			summaries.push({ service: t.service_key, ...valueExtracted });
		} else {
			if (!errorMsg) errorMsg = rpcError ? 'rpc_error' : 'no_details_data';
			summaries.push({ service: t.service_key, status: statusLabel, error: errorMsg });
		}

		await recordCall(runId, {
			serviceName,
			endpointUrl,
			amountAtomic: result.amountAtomic,
			txSig: result.txSig,
			responseData: { service_key: t.service_key, status: statusLabel, rpc_error: result.responseBody?.error || null },
			durationMs: Date.now() - t0,
			success: result.success && !!details && !errorMsg,
			errorMsg: result.success && details && !errorMsg ? null : errorMsg,
			valueExtracted,
		});
	}

	log.info('pricing_tracker_complete', {
		run_id: runId,
		tracked: tracked.length,
		checked,
		paid,
		alerts,
		opportunities,
		spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	return {
		ok: true,
		recorded: true,
		skipped: false,
		success: checked > 0 || paid > 0,
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		signalData: { tracked: tracked.length, checked, paid, alerts, opportunities },
		note: `priced ${checked}/${tracked.length} (alerts=${alerts}, drops=${opportunities})`,
		checked,
		paid,
		summaries,
	};
}

// ── Report reader (consumed by GET /api/x402/service-pricing-report) ──────────
// Aggregates the current tracked-price snapshot into the cost-model dashboard
// shape: every tracked service, the active increase alerts, and the drop
// opportunities. Returns an empty-but-ok shape when the tracker has never run.
export async function readPricingReport({ limit = 200 } = {}) {
	const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
	let rows = [];
	try {
		rows = await sql`
			SELECT service_key, resource, tool_name, name, network, price_atomic,
			       price_label, asset, available, prev_price_atomic, pct_change,
			       price_increase_alert, price_drop_opportunity, checks,
			       first_seen, last_checked
			FROM x402_service_price_current
			ORDER BY last_checked DESC
			LIMIT ${cap}
		`;
	} catch (err) {
		if (/does not exist/i.test(err?.message || '')) {
			return { tracked_count: 0, alert_count: 0, opportunity_count: 0, unavailable_count: 0, services: [], alerts: [], opportunities: [] };
		}
		throw err;
	}

	const services = rows.map((r) => ({
		service_key: r.service_key,
		resource: r.resource,
		tool_name: r.tool_name || null,
		name: r.name || null,
		network: r.network || null,
		price_atomic: r.price_atomic != null ? Number(r.price_atomic) : null,
		price_usdc: r.price_atomic != null ? Number(r.price_atomic) / 1e6 : null,
		price_label: r.price_label || null,
		asset: r.asset || null,
		available: r.available,
		prev_price_atomic: r.prev_price_atomic != null ? Number(r.prev_price_atomic) : null,
		pct_change: r.pct_change != null ? Number(r.pct_change) : null,
		price_increase_alert: r.price_increase_alert,
		price_drop_opportunity: r.price_drop_opportunity,
		checks: Number(r.checks || 0),
		first_seen: r.first_seen,
		last_checked: r.last_checked,
	}));

	return {
		tracked_count: services.length,
		alert_count: services.filter((s) => s.price_increase_alert).length,
		opportunity_count: services.filter((s) => s.price_drop_opportunity).length,
		unavailable_count: services.filter((s) => !s.available).length,
		services,
		alerts: services.filter((s) => s.price_increase_alert),
		opportunities: services.filter((s) => s.price_drop_opportunity),
		thresholds: { increase_alert_pct: INCREASE_ALERT_PCT, drop_opportunity_pct: DROP_OPPORTUNITY_PCT },
	};
}

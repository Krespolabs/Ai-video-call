// api/_lib/x402/pipelines/bazaar-catalog-refresh.js
//
// Bazaar Service Catalog Daily Refresh — autonomous pipeline (self).
//
// Once a day the autonomous spend loop walks the ENTIRE x402 bazaar (every paid
// agent service the facilitator network advertises), snapshots it, and diffs it
// against yesterday's snapshot. The diff is the product:
//
//   • added    — services that appeared since yesterday → OPPORTUNITY alerts.
//                Fresh paid endpoints three.ws could onboard as EXTERNAL_ENDPOINTS.
//   • removed  — services that vanished → PIPELINE-DEPENDENCY alerts. If any active
//                external registry entry pointed at a now-gone resource, that
//                pipeline is about to start failing — surface it before it does.
//   • repriced — services whose min price changed → cost-watch signal.
//
// How it differs from the Bazaar Discovery Warmup (bazaar-warmup.js): the warmup
// sweeps 15 *category searches* to keep the search path warm and snapshots each
// category. This pipeline does a *full-catalog census* (browse every service of
// every type) and computes a single day-over-day diff over the whole catalog —
// the source of truth for "what's new / gone / repriced on the bazaar today".
// The two write to disjoint tables and never collide.
//
// Real x402 payments only. Each MCP tools/call against /api/mcp-bazaar is a real
// on-chain $0.001 USDC payment from the platform seed wallet via payX402(). The
// census is browse_services(http) + browse_services(mcp) (two paid calls), then
// get_service(...) for each newly-appeared service (bounded) to capture its full
// payment requirements for onboarding — the "bazaar_search_services +
// bazaar_service_details" pair this use case is built on. If the wallet/RPC is
// not configured, the pipeline exits gracefully with a logged, recorded skip and
// never pays.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js
// (`bazaar-catalog-refresh`). The per-tick loop (api/cron/x402-autonomous-loop.js)
// hands run() { origin, buyer, conn, blockhash, mintInfo, redis, sql, log, runId,
// remainingCap } and — because this pipeline self-records one x402_autonomous_log
// row per call — gets back { recorded: true } so the loop adds no duplicate row.
//
// Value extracted & where it lands:
//   • bazaar_catalog_snapshots — one row per UTC day: the full catalog (services
//     jsonb), catalog_hash, and the computed added / removed / repriced diff vs
//     the previous day. This is the snapshot + diff record.
//   • bazaar_service_index — durable per-service registry, keyed by service_key
//     (resource [+ #tool]). Tracks first_seen / last_seen, current price + the
//     full payment details from get_service, and status (active | removed). This
//     is the table downstream consumers read.
//   • Redis x402:bazaar:catalog:latest — newest census summary (counts + diff
//     sizes) for cheap dashboard reads without a DB round-trip.
//   • Redis x402:bazaar:dependency-alert — present (with TTL) only while a removed
//     service is still referenced by an active EXTERNAL_ENDPOINTS entry.
//
// Downstream consumers:
//   • External onboarding: bazaar_service_index WHERE status='active' ORDER BY
//     first_seen DESC is the candidate list agents read when wiring new
//     EXTERNAL_ENDPOINTS in autonomous-registry.js — the "opportunity" feed.
//   • Dependency safety: this pipeline itself cross-checks each removed resource
//     against the live external registry (getExternalRegistry) and raises the
//     Redis dependency-alert + a warn log so ops disables a dead external entry
//     before its loop call starts erroring.

import { randomUUID, createHash } from 'node:crypto';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { payX402, bootstrapSolanaContext, USDC_MINT } from '../pay.js';
import { isLivePricedService, serviceKey, extractServices } from './bazaar-warmup.js';

const log = logger('x402-bazaar-catalog-refresh');

const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// The full catalog is the union of both service kinds the bazaar advertises.
// browse_services has no offset cursor, so one call per type at the tool's max
// limit (100) is the deepest census the MCP surface allows; the live facilitator
// network returns well under that per type today, so this captures the catalog
// in full. Documented honestly rather than faking an offset loop the API lacks.
export const CATALOG_TYPES = ['http', 'mcp'];
const BROWSE_LIMIT = 100;

// Cap how many newly-appeared services we pay get_service for per run, so a day
// where the bazaar adds dozens of services can't blow past a sane per-run spend.
// New services beyond the cap are still recorded (from the browse census) and get
// enriched on a later run once they're no longer "new"; the count dropped is logged.
const ENRICH_MAX = Number(process.env.X402_BAZAAR_REFRESH_ENRICH_MAX || 8);

const REDIS_LATEST_KEY = 'x402:bazaar:catalog:latest';
const REDIS_DEP_ALERT_KEY = 'x402:bazaar:dependency-alert';
// Dependency alert TTL: a little over two daily cycles so a missed run lets the
// flag lapse rather than latching a stale alert forever.
const DEP_ALERT_TTL_SECONDS = 50 * 3600;

function utcDay(d = new Date()) {
	return d.toISOString().slice(0, 10);
}

// ── JSON-RPC builders for the two bazaar MCP tools this pipeline pays for ──────
function browseRpc(type, id) {
	return {
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name: 'browse_services', arguments: { type, limit: BROWSE_LIMIT } },
	};
}

function getServiceRpc(resourceUrl, toolName, id) {
	return {
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: {
			name: 'get_service',
			arguments: { resource_url: resourceUrl, ...(toolName ? { tool_name: toolName } : {}) },
		},
	};
}

// Project a live bazaar listing down to the slim shape stored in the snapshot +
// index. Keyed identically to the warmup so the two views agree on identity.
function projectService(s) {
	return {
		key: serviceKey(s),
		resource: s.resource,
		tool_name: s.tool_name || null,
		type: s.type || (s.tool_name ? 'mcp' : 'http'),
		name: s.name || null,
		description: s.description || null,
		price_atomic: s.price_atomic ?? null,
		price: s.price || null,
		networks: Array.isArray(s.networks) ? s.networks : [],
		tags: Array.isArray(s.tags) ? s.tags : [],
	};
}

// Deterministic hash of the whole catalog (key + price) so a reprice OR an
// add/remove flips it — a cheap "did anything change at all today?" check.
export function catalogHash(services) {
	const lines = services.map((s) => `${s.key}|${s.price_atomic ?? s.price ?? ''}`).sort();
	return createHash('sha256').update(lines.join('\n')).digest('hex');
}

// Compute the day-over-day diff between two key→service maps.
export function diffCatalog(prevMap, todayMap) {
	const added = [];
	const removed = [];
	const repriced = [];
	for (const [key, svc] of todayMap) {
		if (!prevMap.has(key)) {
			added.push({ key, resource: svc.resource, tool_name: svc.tool_name, name: svc.name, price_atomic: svc.price_atomic, networks: svc.networks });
		} else {
			const before = prevMap.get(key);
			const a = before.price_atomic ?? null;
			const b = svc.price_atomic ?? null;
			if (a !== b) repriced.push({ key, resource: svc.resource, old_price_atomic: a, new_price_atomic: b });
		}
	}
	for (const [key, svc] of prevMap) {
		if (!todayMap.has(key)) {
			removed.push({ key, resource: svc.resource, tool_name: svc.tool_name, name: svc.name });
		}
	}
	return { added, removed, repriced };
}

// ── Schema ────────────────────────────────────────────────────────────────────
let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	// One row per UTC day — the snapshot + the diff vs the prior day.
	await sql`
		CREATE TABLE IF NOT EXISTS bazaar_catalog_snapshots (
			snapshot_date   date PRIMARY KEY,
			run_id          uuid,
			ts              timestamptz NOT NULL DEFAULT now(),
			service_count   int NOT NULL DEFAULT 0,
			http_count      int NOT NULL DEFAULT 0,
			mcp_count       int NOT NULL DEFAULT 0,
			catalog_hash    text,
			prev_date       date,
			changed         boolean NOT NULL DEFAULT false,
			added_count     int NOT NULL DEFAULT 0,
			removed_count   int NOT NULL DEFAULT 0,
			repriced_count  int NOT NULL DEFAULT 0,
			services        jsonb NOT NULL DEFAULT '[]'::jsonb,
			added           jsonb NOT NULL DEFAULT '[]'::jsonb,
			removed         jsonb NOT NULL DEFAULT '[]'::jsonb,
			repriced        jsonb NOT NULL DEFAULT '[]'::jsonb,
			errors          jsonb
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS bazaar_catalog_snapshots_ts ON bazaar_catalog_snapshots (ts DESC)`;

	// Durable per-service registry — the value sink consumers read. One row per
	// service_key; first_seen/last_seen track lifetime, status flips on removal.
	await sql`
		CREATE TABLE IF NOT EXISTS bazaar_service_index (
			service_key   text PRIMARY KEY,
			resource      text NOT NULL,
			tool_name     text,
			type          text,
			name          text,
			description   text,
			price_atomic  bigint,
			price         text,
			networks      text[] NOT NULL DEFAULT '{}',
			tags          jsonb NOT NULL DEFAULT '[]'::jsonb,
			details       jsonb,
			status        text NOT NULL DEFAULT 'active',
			first_seen    timestamptz NOT NULL DEFAULT now(),
			last_seen     timestamptz NOT NULL DEFAULT now(),
			removed_at    timestamptz,
			last_run_id   uuid
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS bazaar_service_index_status_first ON bazaar_service_index (status, first_seen DESC)`;

	// The autonomous log predates this pipeline; ensure value_extracted exists.
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

// Per-call row into x402_autonomous_log. This pipeline owns its granular rows
// (one per paid bazaar call); the loop adds no summary row (outcome.recorded).
async function recordCall(sql, runId, { serviceName, endpointUrl, amountAtomic, txSig, responseData, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${serviceName}, ${endpointUrl},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${ASSET}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'discovery'})
		`;
	} catch (err) {
		log.warn('bazaar_refresh_log_insert_failed', { service: serviceName, message: err?.message });
	}
}

// Most-recent snapshot strictly before today, for the day-over-day diff.
async function loadPreviousCatalog(sql, today) {
	try {
		const [row] = await sql`
			SELECT snapshot_date, services
			FROM bazaar_catalog_snapshots
			WHERE snapshot_date < ${today}
			ORDER BY snapshot_date DESC
			LIMIT 1
		`;
		if (!row) return { prevDate: null, map: new Map() };
		const map = new Map();
		for (const s of Array.isArray(row.services) ? row.services : []) {
			if (s?.key) map.set(s.key, s);
		}
		return { prevDate: row.snapshot_date, map };
	} catch (err) {
		if (!/does not exist/i.test(err?.message || '')) {
			log.warn('bazaar_refresh_prev_load_failed', { message: err?.message });
		}
		return { prevDate: null, map: new Map() };
	}
}

// Pull the full payment requirements out of a get_service tools/call body.
function extractServiceDetails(responseBody) {
	const sc = responseBody?.result?.structuredContent;
	if (!sc || !sc.resource) return null;
	return {
		resource: sc.resource,
		tool_name: sc.tool_name || null,
		name: sc.name || null,
		description: sc.description || null,
		accepts: Array.isArray(sc.accepts) ? sc.accepts : [],
		input_schema: sc.input_schema || null,
		pay_link: sc.pay_link || null,
	};
}

// Upsert today's live services into the durable index, refreshing price/details
// and last_seen. Returns nothing — best-effort, never throws past the loop.
async function indexActiveServices(sql, runId, services, detailsByKey) {
	for (const s of services) {
		const details = detailsByKey.get(s.key) || null;
		try {
			await sql`
				INSERT INTO bazaar_service_index
					(service_key, resource, tool_name, type, name, description,
					 price_atomic, price, networks, tags, details, status,
					 first_seen, last_seen, removed_at, last_run_id)
				VALUES
					(${s.key}, ${s.resource}, ${s.tool_name}, ${s.type}, ${s.name}, ${s.description},
					 ${s.price_atomic}, ${s.price}, ${s.networks}, ${JSON.stringify(s.tags)},
					 ${details ? JSON.stringify(details) : null}, ${'active'},
					 now(), now(), ${null}, ${runId})
				ON CONFLICT (service_key) DO UPDATE SET
					resource     = EXCLUDED.resource,
					tool_name    = EXCLUDED.tool_name,
					type         = EXCLUDED.type,
					name         = EXCLUDED.name,
					description  = EXCLUDED.description,
					price_atomic = EXCLUDED.price_atomic,
					price        = EXCLUDED.price,
					networks     = EXCLUDED.networks,
					tags         = EXCLUDED.tags,
					details      = COALESCE(EXCLUDED.details, bazaar_service_index.details),
					status       = 'active',
					last_seen    = now(),
					removed_at   = NULL,
					last_run_id  = EXCLUDED.last_run_id
			`;
		} catch (err) {
			log.warn('bazaar_refresh_index_upsert_failed', { key: s.key, message: err?.message });
		}
	}
}

// Mark services that disappeared this run as removed (status + removed_at).
async function markRemovedServices(sql, runId, removed) {
	for (const r of removed) {
		try {
			await sql`
				UPDATE bazaar_service_index
				SET status = 'removed', removed_at = now(), last_run_id = ${runId}
				WHERE service_key = ${r.key} AND status <> 'removed'
			`;
		} catch (err) {
			log.warn('bazaar_refresh_mark_removed_failed', { key: r.key, message: err?.message });
		}
	}
}

// Cross-check removed resources against the live external registry. If any active
// EXTERNAL_ENDPOINTS entry pointed at a now-gone bazaar resource, its loop call is
// about to start failing — raise a dependency alert (Redis + warn log).
async function checkDependencyImpact(redis, removed) {
	let externals = [];
	try {
		// Lazy import to avoid a static import cycle (autonomous-registry imports
		// this pipeline's run() at module-eval time).
		const { getExternalRegistry } = await import('../autonomous-registry.js');
		externals = getExternalRegistry().filter((e) => e && e.enabled !== false);
	} catch { externals = []; }
	if (!externals.length || !removed.length) {
		if (redis) { try { await redis.del(REDIS_DEP_ALERT_KEY); } catch { /* non-fatal */ } }
		return [];
	}
	const removedResources = new Set(removed.map((r) => r.resource).filter(Boolean));
	const impacted = externals
		.filter((e) => {
			const url = e.url || '';
			for (const res of removedResources) {
				if (res && (url === res || url.startsWith(res) || res.startsWith(url))) return true;
			}
			return false;
		})
		.map((e) => ({ id: e.id, name: e.name, url: e.url }));

	if (redis) {
		try {
			if (impacted.length) {
				await redis.set(REDIS_DEP_ALERT_KEY, JSON.stringify({ ts: new Date().toISOString(), impacted }), { ex: DEP_ALERT_TTL_SECONDS });
			} else {
				await redis.del(REDIS_DEP_ALERT_KEY);
			}
		} catch (err) {
			log.warn('bazaar_refresh_dep_alert_write_failed', { message: err?.message });
		}
	}
	if (impacted.length) {
		log.warn('bazaar_dependency_alert', { impacted });
	}
	return impacted;
}

async function writeRedisLatest(redis, summary) {
	if (!redis) return;
	try {
		await redis.set(REDIS_LATEST_KEY, JSON.stringify(summary), { ex: DEP_ALERT_TTL_SECONDS });
	} catch (err) {
		log.warn('bazaar_refresh_redis_latest_failed', { message: err?.message });
	}
}

/**
 * Run the catalog refresh. Conforms to the run()-style registry contract: the
 * loop hands { origin, buyer, conn, blockhash, mintInfo, redis, sql, log, runId,
 * remainingCap }; standalone (manual test) it bootstraps its own Solana context.
 *
 * Self-records one x402_autonomous_log row per paid call and returns
 * { recorded: true } so the loop adds no duplicate summary row.
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const sql = ctx.sql || defaultSql;
	const redis = ctx.redis || null;
	const endpointUrl = `${origin}/api/mcp-bazaar`;
	const today = utcDay();
	let remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;

	// ── Schema first: without the sink there's nothing to extract, so don't pay.
	try {
		await ensureSchema(sql);
	} catch (err) {
		log.warn('bazaar_refresh_schema_failed', { message: err?.message });
		return { success: false, skipped: true, recorded: false, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	// ── Solana payment context: reuse the loop's, else bootstrap (graceful on an
	//    unconfigured wallet — bootstrap throws, we exit logged without paying).
	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			log.info('bazaar_refresh_skipped', { reason: err.message });
			return { success: false, skipped: true, recorded: false, amountAtomic: 0, errorMsg: err.message, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	let spentAtomic = 0;
	let paid = 0;
	let lastTxSig = null;
	let callErrors = 0;
	const callErrorMsgs = [];
	const todayMap = new Map();
	const countsByType = { http: 0, mcp: 0 };

	// ── Census: browse every service of every type (one paid call per type) ─────
	for (let i = 0; i < CATALOG_TYPES.length; i++) {
		const type = CATALOG_TYPES[i];
		if (remainingCap <= 0) { log.info('bazaar_refresh_cap_reached', { type, spent_atomic: spentAtomic }); break; }

		const t0 = Date.now();
		let result;
		try {
			result = await payX402({
				url: endpointUrl, method: 'POST', body: browseRpc(type, i + 1),
				buyer, conn, blockhash, mintInfo, remainingCap, nonce: i + 1,
			});
		} catch (err) {
			callErrors += 1;
			callErrorMsgs.push(`browse_${type}: ${err?.message || 'fetch_failed'}`);
			await recordCall(sql, runId, {
				serviceName: `Bazaar Census: browse ${type}`, endpointUrl, amountAtomic: 0, txSig: null,
				responseData: null, durationMs: Date.now() - t0, success: false,
				errorMsg: err?.message || 'fetch_failed', valueExtracted: null,
			});
			continue;
		}

		if (result.paid) { spentAtomic += result.amountAtomic; remainingCap -= result.amountAtomic; paid += 1; if (result.txSig) lastTxSig = result.txSig; }

		const { services, errors, hasResult } = extractServices(result.responseBody);
		let live = 0;
		if (result.success && hasResult) {
			for (const raw of services) {
				if (!isLivePricedService(raw)) continue;
				const p = projectService(raw);
				if (!p.key) continue;
				if (!todayMap.has(p.key)) { todayMap.set(p.key, p); live += 1; countsByType[type] = (countsByType[type] || 0) + 1; }
			}
		} else {
			callErrors += 1;
			callErrorMsgs.push(`browse_${type}: ${result.errorMsg || `status_${result.status}`}`);
		}

		await recordCall(sql, runId, {
			serviceName: `Bazaar Census: browse ${type}`,
			endpointUrl,
			amountAtomic: result.amountAtomic,
			txSig: result.txSig,
			responseData: { status: result.status, total: services.length, live, rpc_error: result.responseBody?.error || null },
			durationMs: Date.now() - t0,
			success: result.success && hasResult,
			errorMsg: result.errorMsg || (errors ? 'facilitator_errors' : null),
			valueExtracted: { type, live, total: services.length },
		});
	}

	// ── Diff vs the previous day ───────────────────────────────────────────────
	const { prevDate, map: prevMap } = await loadPreviousCatalog(sql, today);
	const { added, removed, repriced } = diffCatalog(prevMap, todayMap);
	const hash = catalogHash([...todayMap.values()]);
	// First-ever run (no prior snapshot): everything is "seen", nothing is an
	// opportunity/removal yet — suppress the noise of a whole-catalog "added".
	const firstRun = prevMap.size === 0 && prevDate == null;
	const opportunities = firstRun ? [] : added;
	const removals = firstRun ? [] : removed;
	const reprices = firstRun ? [] : repriced;

	// ── Enrich opportunity alerts: pay get_service for each new service (bounded)
	const detailsByKey = new Map();
	const toEnrich = opportunities.slice(0, ENRICH_MAX);
	const enrichDropped = Math.max(0, opportunities.length - toEnrich.length);
	for (let i = 0; i < toEnrich.length; i++) {
		const svc = toEnrich[i];
		if (remainingCap <= 0) { log.info('bazaar_refresh_enrich_cap_reached', { remaining: toEnrich.length - i }); break; }

		const t0 = Date.now();
		let result;
		try {
			result = await payX402({
				url: endpointUrl, method: 'POST',
				body: getServiceRpc(svc.resource, svc.tool_name, 100 + i),
				buyer, conn, blockhash, mintInfo, remainingCap, nonce: 100 + i,
			});
		} catch (err) {
			callErrors += 1;
			callErrorMsgs.push(`get_service ${svc.key}: ${err?.message || 'fetch_failed'}`);
			await recordCall(sql, runId, {
				serviceName: `Bazaar Details: ${svc.name || svc.resource}`, endpointUrl, amountAtomic: 0, txSig: null,
				responseData: null, durationMs: Date.now() - t0, success: false,
				errorMsg: err?.message || 'fetch_failed', valueExtracted: null,
			});
			continue;
		}

		if (result.paid) { spentAtomic += result.amountAtomic; remainingCap -= result.amountAtomic; paid += 1; if (result.txSig) lastTxSig = result.txSig; }

		const details = result.success ? extractServiceDetails(result.responseBody) : null;
		if (details) detailsByKey.set(svc.key, details);
		else { callErrors += 1; callErrorMsgs.push(`get_service ${svc.key}: ${result.errorMsg || `status_${result.status}`}`); }

		await recordCall(sql, runId, {
			serviceName: `Bazaar Details: ${svc.name || svc.resource}`,
			endpointUrl,
			amountAtomic: result.amountAtomic,
			txSig: result.txSig,
			responseData: { status: result.status, resolved: !!details, rpc_error: result.responseBody?.error || null },
			durationMs: Date.now() - t0,
			success: result.success && !!details,
			errorMsg: result.errorMsg,
			valueExtracted: details ? { resource: details.resource, accepts: details.accepts.length, opportunity: true } : null,
		});
	}

	// ── Persist: the durable index, the removals, and the daily snapshot row ────
	const todayServices = [...todayMap.values()];
	await indexActiveServices(sql, runId, todayServices, detailsByKey);
	await markRemovedServices(sql, runId, removals);

	const changed = prevDate != null && (opportunities.length > 0 || removals.length > 0 || reprices.length > 0);
	try {
		await sql`
			INSERT INTO bazaar_catalog_snapshots
				(snapshot_date, run_id, ts, service_count, http_count, mcp_count, catalog_hash,
				 prev_date, changed, added_count, removed_count, repriced_count,
				 services, added, removed, repriced, errors)
			VALUES
				(${today}, ${runId}, now(), ${todayServices.length}, ${countsByType.http || 0}, ${countsByType.mcp || 0}, ${hash},
				 ${prevDate}, ${changed}, ${opportunities.length}, ${removals.length}, ${reprices.length},
				 ${JSON.stringify(todayServices)}, ${JSON.stringify(opportunities)},
				 ${JSON.stringify(removals)}, ${JSON.stringify(reprices)},
				 ${callErrorMsgs.length ? JSON.stringify(callErrorMsgs) : null})
			ON CONFLICT (snapshot_date) DO UPDATE SET
				run_id         = EXCLUDED.run_id,
				ts             = now(),
				service_count  = EXCLUDED.service_count,
				http_count     = EXCLUDED.http_count,
				mcp_count      = EXCLUDED.mcp_count,
				catalog_hash   = EXCLUDED.catalog_hash,
				prev_date      = EXCLUDED.prev_date,
				changed        = EXCLUDED.changed,
				added_count    = EXCLUDED.added_count,
				removed_count  = EXCLUDED.removed_count,
				repriced_count = EXCLUDED.repriced_count,
				services       = EXCLUDED.services,
				added          = EXCLUDED.added,
				removed        = EXCLUDED.removed,
				repriced       = EXCLUDED.repriced,
				errors         = EXCLUDED.errors
		`;
	} catch (err) {
		log.warn('bazaar_refresh_snapshot_failed', { message: err?.message });
	}

	// ── Alerts: pipeline-dependency impact + cheap dashboard summary ────────────
	const impacted = await checkDependencyImpact(redis, removals);
	const summary = {
		ts: new Date().toISOString(),
		snapshot_date: today,
		prev_date: prevDate,
		service_count: todayServices.length,
		http_count: countsByType.http || 0,
		mcp_count: countsByType.mcp || 0,
		added: opportunities.length,
		removed: removals.length,
		repriced: reprices.length,
		dependency_impacted: impacted.length,
		first_run: firstRun,
	};
	await writeRedisLatest(redis, summary);

	log.info('bazaar_refresh_complete', {
		run_id: runId, snapshot_date: today, prev_date: prevDate,
		services: todayServices.length, http: countsByType.http || 0, mcp: countsByType.mcp || 0,
		added: opportunities.length, removed: removals.length, repriced: reprices.length,
		enriched: detailsByKey.size, enrich_dropped: enrichDropped,
		dependency_impacted: impacted.length, paid, spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	// Aggregate outcome for the loop. recorded:true — the per-call rows above are
	// the canonical record; the loop adds no duplicate summary row.
	return {
		success: paid > 0 || todayServices.length > 0,
		recorded: true,
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		errorMsg: paid === 0 && callErrors > 0 ? `bazaar_refresh_calls_failed:${callErrors}` : null,
		skipped: paid === 0 && todayServices.length === 0,
		responseData: {
			service_count: todayServices.length, added: opportunities.length,
			removed: removals.length, repriced: reprices.length, paid,
		},
		note: `bazaar_refresh services=${todayServices.length} +${opportunities.length}/-${removals.length}/~${reprices.length} impacted=${impacted.length}`,
	};
}

export const BAZAAR_CATALOG_REFRESH = Object.freeze({
	endpoint: '/api/mcp-bazaar',
	priceAtomic: 1000, // $0.001 USDC per call
	cooldownSeconds: 86400, // daily census
	redisLatestKey: REDIS_LATEST_KEY,
	redisDependencyAlertKey: REDIS_DEP_ALERT_KEY,
	enrichMax: ENRICH_MAX,
});

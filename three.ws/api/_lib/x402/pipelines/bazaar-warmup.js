// api/_lib/x402/pipelines/bazaar-warmup.js
//
// Bazaar Discovery Warmup — autonomous pipeline (self/008).
//
// On each run it pays for 15 category searches against the three.ws x402 Bazaar
// MCP server (/api/mcp-bazaar → search_services). Each call is a real on-chain
// USDC payment from the seed wallet at the advertised $0.001/call. The pipeline:
//
//   1. Probes + pays each search via the shared payX402 client (real x402,
//      never mocked).
//   2. Validates every returned service is a *live, priced* endpoint
//      (resource URL + price + network) and drops malformed listings.
//   3. Records a row in x402_autonomous_log for every call (success or failure),
//      with the extracted catalog summary in value_extracted.
//   4. Snapshots the discovered catalog per category into x402_bazaar_catalog
//      and compares it to the previous run to surface drift (services
//      added / removed / repriced since the last warmup).
//
// Wiring: declared as a run()-style entry in autonomous-registry.js. The
// per-tick loop (api/cron/x402-autonomous-loop.js) hands run() a shared payment
// context (buyer, conn, blockhash, mintInfo, remainingCap); called standalone
// (manual test) it bootstraps its own context via bootstrapSolanaContext().
//
// Downstream consumer: the snapshots in x402_bazaar_catalog are the source list
// for external x402 service onboarding — agents wiring EXTERNAL_ENDPOINTS in
// autonomous-registry.js read the latest live, priced resources from here, and
// the per-category `drifted` flag feeds the external pipeline so a service that
// disappears or reprices is caught without a manual recrawl.

import { randomUUID, createHash } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { payX402, bootstrapSolanaContext, USDC_MINT } from '../pay.js';

const log = logger('x402-bazaar-warmup');

// 15 discovery categories swept on every warmup. Broad enough to exercise the
// full facilitator catalog; each maps to a search_services(query) call.
export const WARMUP_CATEGORIES = [
	'trading', 'llm', 'analytics', 'onchain data', 'weather',
	'image', 'search', 'storage', 'identity', 'payments',
	'oracle', 'social', 'gaming', 'compute', 'audio',
];

const PER_CATEGORY_LIMIT = 25;
const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// A bazaar listing is "live + priced" only when an agent could actually pay it:
// it must carry a resource URL, a price (atomic units or label), and a network.
export function isLivePricedService(s) {
	if (!s || typeof s.resource !== 'string' || !s.resource) return false;
	const hasPrice = s.price_atomic != null || (typeof s.price === 'string' && s.price.length > 0);
	const hasNetwork = Array.isArray(s.networks) && s.networks.length > 0;
	return hasPrice && hasNetwork;
}

// Stable identifier for a service within a category — resource plus the MCP tool
// name when present (one resource can expose many priced tools).
export function serviceKey(s) {
	return s.tool_name ? `${s.resource}#${s.tool_name}` : s.resource;
}

// Deterministic hash of the live catalog for a category, used for drift
// detection. Includes price so a reprice registers as drift, not just add/remove.
export function catalogHash(services) {
	const lines = services
		.map((s) => `${serviceKey(s)}|${s.price_atomic ?? s.price ?? ''}`)
		.sort();
	return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function jsonRpcSearch(category, id) {
	return {
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: {
			name: 'search_services',
			arguments: { query: category, type: 'http', limit: PER_CATEGORY_LIMIT },
		},
	};
}

// Pull the search_services structuredContent out of a JSON-RPC tools/call body.
export function extractServices(responseBody) {
	const sc = responseBody?.result?.structuredContent;
	if (!sc || !Array.isArray(sc.services)) return { services: [], sources: null, errors: null, hasResult: !!responseBody?.result };
	return { services: sc.services, sources: sc.sources || null, errors: sc.errors || null, hasResult: true };
}

async function ensureSchema() {
	// Catalog snapshot — one row per (run, category). Drift compares the latest
	// run against the previous one keyed on category.
	await sql`
		CREATE TABLE IF NOT EXISTS x402_bazaar_catalog (
			id              bigserial PRIMARY KEY,
			run_id          uuid NOT NULL,
			ts              timestamptz DEFAULT now(),
			category        text NOT NULL,
			service_count   int NOT NULL DEFAULT 0,
			live_count      int NOT NULL DEFAULT 0,
			networks        text[] NOT NULL DEFAULT '{}',
			resources       jsonb NOT NULL DEFAULT '[]'::jsonb,
			catalog_hash    text,
			drifted         boolean NOT NULL DEFAULT false,
			added           jsonb NOT NULL DEFAULT '[]'::jsonb,
			removed         jsonb NOT NULL DEFAULT '[]'::jsonb,
			sources         jsonb,
			errors          jsonb
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS x402_bazaar_catalog_cat_ts ON x402_bazaar_catalog (category, ts DESC)`;
	// The autonomous log predates this pipeline; add the value_extracted column
	// the warmup records its parsed catalog summary into (idempotent).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
}

// Per-call row into x402_autonomous_log, including value_extracted. The loop
// also records one aggregate row for the run() entry; these are the granular
// per-category rows the warmup owns.
async function recordCall(runId, { category, endpointUrl, amountAtomic, txSig, responseData, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${`Bazaar Warmup: ${category}`}, ${endpointUrl},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${ASSET}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'discovery'})
		`;
	} catch (err) {
		log.warn('bazaar_warmup_log_insert_failed', { category, message: err?.message });
	}
}

// Most-recent prior catalog_hash + key set per category, for drift comparison.
async function loadPreviousCatalog(runId) {
	const prev = new Map();
	try {
		const rows = await sql`
			SELECT DISTINCT ON (category) category, catalog_hash, resources
			FROM x402_bazaar_catalog
			WHERE run_id <> ${runId}
			ORDER BY category, ts DESC
		`;
		for (const r of rows) {
			const keys = Array.isArray(r.resources) ? r.resources.map((s) => s.key).filter(Boolean) : [];
			prev.set(r.category, { hash: r.catalog_hash, keys: new Set(keys) });
		}
	} catch (err) {
		if (!err?.message?.includes('does not exist')) {
			log.warn('bazaar_warmup_prev_load_failed', { message: err?.message });
		}
	}
	return prev;
}

async function snapshotCategory(runId, category, services, sources, errors, prev) {
	const live = services.filter(isLivePricedService);
	const resources = live.map((s) => ({
		key: serviceKey(s),
		resource: s.resource,
		tool_name: s.tool_name || null,
		price_atomic: s.price_atomic ?? null,
		price: s.price || null,
		networks: s.networks || [],
	}));
	const networks = [...new Set(live.flatMap((s) => s.networks || []))];
	const hash = catalogHash(live);

	const before = prev.get(category);
	const liveKeys = new Set(resources.map((r) => r.key));
	const drifted = before ? before.hash !== hash : false;
	const added = before ? [...liveKeys].filter((k) => !before.keys.has(k)) : [];
	const removed = before ? [...before.keys].filter((k) => !liveKeys.has(k)) : [];

	try {
		await sql`
			INSERT INTO x402_bazaar_catalog
				(run_id, category, service_count, live_count, networks,
				 resources, catalog_hash, drifted, added, removed, sources, errors)
			VALUES
				(${runId}, ${category}, ${services.length}, ${live.length}, ${networks},
				 ${JSON.stringify(resources)}, ${hash}, ${drifted},
				 ${JSON.stringify(added)}, ${JSON.stringify(removed)},
				 ${sources ? JSON.stringify(sources) : null},
				 ${errors ? JSON.stringify(errors) : null})
		`;
	} catch (err) {
		log.warn('bazaar_warmup_snapshot_failed', { category, message: err?.message });
	}

	return { category, total: services.length, live: live.length, networks, catalog_hash: hash, drifted, added, removed };
}

/**
 * Run the warmup. Conforms to the run()-style registry contract: the loop hands
 * over { origin, buyer, conn, blockhash, mintInfo, remainingCap, runId }; when
 * any of the Solana context is absent (standalone / manual test) it bootstraps
 * its own via bootstrapSolanaContext().
 *
 * Returns the aggregate outcome the loop records as one summary row:
 *   { success, amountAtomic, txSig, errorMsg, responseData, skipped, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const endpointUrl = `${origin}/api/mcp-bazaar`;
	let remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;

	// ── Schema first: without the sink there is no value to extract, so don't pay.
	try {
		await ensureSchema();
	} catch (err) {
		log.warn('bazaar_warmup_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	// ── Solana payment context: reuse the loop's, else bootstrap (graceful on
	//    unconfigured wallet — bootstrap throws, we exit logged without paying).
	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			log.info('bazaar_warmup_skipped', { reason: err.message });
			return { success: false, skipped: true, amountAtomic: 0, errorMsg: err.message, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	const prev = await loadPreviousCatalog(runId);

	let spentAtomic = 0;
	let paid = 0;
	let lastTxSig = null;
	let callErrors = 0;
	const snapshots = [];

	for (let i = 0; i < WARMUP_CATEGORIES.length; i++) {
		const category = WARMUP_CATEGORIES[i];
		if (remainingCap <= 0) {
			log.info('bazaar_warmup_cap_reached', { category, spent_atomic: spentAtomic });
			break;
		}

		const t0 = Date.now();
		let result;
		try {
			result = await payX402({
				url: endpointUrl,
				method: 'POST',
				body: jsonRpcSearch(category, i + 1),
				buyer, conn, blockhash, mintInfo,
				remainingCap,
			});
		} catch (err) {
			// Network failure / abort — log the call, never crash the sweep.
			callErrors += 1;
			await recordCall(runId, {
				category, endpointUrl, amountAtomic: 0, txSig: null, responseData: null,
				durationMs: Date.now() - t0, success: false, errorMsg: err?.message || 'fetch_failed', valueExtracted: null,
			});
			snapshots.push({ category, error: err?.message || 'fetch_failed' });
			continue;
		}

		const { services, sources, errors, hasResult } = extractServices(result.responseBody);

		// Snapshot only when the call actually delivered a JSON-RPC result
		// (paid or free success). Failed / 402-rejected calls still get a log row.
		let snapshot = null;
		if (result.success && hasResult) {
			snapshot = await snapshotCategory(runId, category, services, sources, errors, prev);
			snapshots.push(snapshot);
		} else {
			callErrors += 1;
			snapshots.push({ category, status: result.status, error: result.errorMsg });
		}

		if (result.paid) {
			spentAtomic += result.amountAtomic;
			remainingCap -= result.amountAtomic;
			paid += 1;
			if (result.txSig) lastTxSig = result.txSig;
		}

		const valueExtracted = snapshot
			? {
				live: snapshot.live, total: snapshot.total, networks: snapshot.networks,
				catalog_hash: snapshot.catalog_hash, drifted: snapshot.drifted,
				added: snapshot.added.length, removed: snapshot.removed.length,
			}
			: null;

		await recordCall(runId, {
			category,
			endpointUrl,
			amountAtomic: result.amountAtomic,
			txSig: result.txSig,
			// Drop the bulky service list — the snapshot row captures the useful
			// shape; keep just the call status and rpc-level error if any.
			responseData: { status: result.status, count: services.length, rpc_error: result.responseBody?.error || null },
			durationMs: Date.now() - t0,
			success: result.success,
			errorMsg: result.errorMsg,
			valueExtracted,
		});
	}

	const driftCount = snapshots.filter((s) => s?.drifted).length;
	const liveTotal = snapshots.reduce((n, s) => n + (s?.live || 0), 0);
	log.info('bazaar_warmup_complete', {
		run_id: runId,
		categories: WARMUP_CATEGORIES.length,
		calls: snapshots.length,
		paid,
		live_services: liveTotal,
		drift: driftCount,
		spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	// Aggregate outcome for the loop's single summary row. success=true when at
	// least one category resolved; per-call detail lives in the rows above.
	return {
		success: paid > 0 || (snapshots.length > 0 && callErrors < snapshots.length),
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		errorMsg: paid === 0 && callErrors > 0 ? `bazaar_warmup_calls_failed:${callErrors}` : null,
		skipped: paid === 0 && snapshots.length === 0,
		responseData: {
			categories: WARMUP_CATEGORIES.length,
			calls: snapshots.length,
			paid,
			live_services: liveTotal,
			drift: driftCount,
		},
		note: `bazaar_warmup paid=${paid} live=${liveTotal} drift=${driftCount}`,
	};
}

// api/_lib/x402/glb-size-optimizer.js
//
// GLB Size Optimizer — autonomous pipeline (self/018).
//
// On each run it picks the single largest public avatar GLB in the catalog that
// is over the 5 MB web-delivery budget and has not been analyzed in the last
// ANALYZE_TTL_DAYS, then pays one real on-chain x402 USDC call to
// /api/mcp (optimize_model) to inspect it and surface concrete size reductions
// (Draco/Meshopt geometry compression, 4K→2K texture downscale, PNG→KTX2
// transcoding, re-indexing, material merging).
//
// optimize_model returns measured model statistics + actionable suggestions — it
// does not re-encode the GLB itself. So this pipeline computes a grounded
// projection of the post-optimization size from the model's *real* measured
// stats (vertex count, per-texture dimensions and byte sizes, extensions in use)
// using the same compression ratios the suggestions cite, and stores the
// original size alongside the projected optimized size and load-time improvement.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js. The per-tick
// loop (api/cron/x402-autonomous-loop.js) hands run() a shared payment context
// (buyer, conn, blockhash, mintInfo, remainingCap) and records the returned
// aggregate as one summary row. Called standalone (manual test) it bootstraps its
// own context via bootstrapSolanaContext().
//
// Real on-chain payments only — no mocks. If the seed wallet or RPC is not
// configured, run() exits gracefully with a logged, recorded skip.
//
// Storage:
//   glb_optimizations          — one row per analyzed model. original_bytes,
//                                estimated_optimized_bytes, estimated_savings_bytes,
//                                savings_pct, load_ms_before/after, the full
//                                suggestions + inspection info, and the paying
//                                tx_signature. This is the canonical "value
//                                extracted" store for this pipeline.
//   x402_autonomous_log        — one detailed row per call (value_extracted = the
//                                savings summary), mirroring the bazaar pipeline.
//
// Downstream consumer:
//   GET /api/x402/glb-optimization-report reads glb_optimizations to report the
//   catalog-wide average size + load-time improvement and the per-model backlog
//   of un-optimized heavy GLBs. The avatar gallery surfaces the per-model
//   "save ~N%" hint from the latest row for each avatar.

import { randomUUID } from 'node:crypto';

import { sql } from '../db.js';
import { logger } from '../usage.js';
import { publicUrl } from '../r2.js';
import { env } from '../env.js';
import {
	payX402, bootstrapSolanaContext, loadSeedKeypair, USDC_MINT,
} from './pay.js';

const log = logger('x402-glb-size-optimizer');

const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// The web-delivery budget. GLBs heavier than this are optimization candidates.
export const SIZE_THRESHOLD_BYTES = 5 * 1024 * 1024;

// Don't re-analyze a model that was analyzed within this window — the catalog is
// swept gradually, one heavy model per run, stalest/biggest first.
const ANALYZE_TTL_DAYS = 14;

// Reference download bandwidth for the load-time projection: ~12 Mbps, the rough
// global median 4G throughput. Used identically for before/after so the *delta*
// is bandwidth-independent; the absolute ms are indicative.
const REFERENCE_BYTES_PER_SEC = 1_500_000;

// Grounded compression ratios (retained fraction after optimization), drawn from
// the figures the optimize_model suggestions themselves cite:
//   • Draco geometry: "~60-80% smaller vertex buffers" → retain 0.30 (70% off).
//   • Texture downscale: exact area ratio from real width/height (no constant).
//   • KTX2 (Basis) over PNG: ~0.30 retained; over JPEG: ~0.60 retained.
const GEOM_RETAINED_DRACO = 0.30;
const KTX2_RETAINED_PNG = 0.30;
const KTX2_RETAINED_JPEG = 0.60;
// Per-vertex byte estimate for an uncompressed glTF vertex (position 12 + normal
// 12 + uv 8). Conservative — rigged avatars carry more (tangents, joints) so the
// real geometry weight, and thus the Draco win, is typically larger than modeled.
const BYTES_PER_VERTEX = 32;
const TARGET_TEXTURE_DIM = 2048;

let schemaReady = false;

export async function ensureOptimizationSchema() {
	if (schemaReady) return;
	try {
		await sql`
			CREATE TABLE IF NOT EXISTS glb_optimizations (
				id                         bigserial PRIMARY KEY,
				avatar_id                  uuid,
				slug                       text,
				name                       text,
				source_url                 text NOT NULL,
				original_bytes             bigint NOT NULL,
				estimated_optimized_bytes  bigint NOT NULL,
				estimated_savings_bytes    bigint NOT NULL,
				savings_pct                numeric(6,2),
				load_ms_before             int,
				load_ms_after              int,
				load_improvement_pct       numeric(6,2),
				triangles                  bigint,
				vertices                   bigint,
				texture_count              int,
				texture_bytes              bigint,
				suggestion_ids             text[],
				suggestions                jsonb,
				info                       jsonb,
				run_id                     uuid,
				tx_signature               text,
				amount_atomic              bigint,
				analyzed_at                timestamptz NOT NULL DEFAULT now()
			)
		`;
		await sql`CREATE INDEX IF NOT EXISTS glb_optimizations_avatar_idx ON glb_optimizations (avatar_id, analyzed_at DESC)`;
		await sql`CREATE INDEX IF NOT EXISTS glb_optimizations_savings_idx ON glb_optimizations (savings_pct DESC)`;
		// value_extracted lives on the shared loop log table; ensure it exists so
		// our detailed row can populate it even if this pipeline runs first.
		await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
		schemaReady = true;
	} catch (err) {
		if (!/already exists/i.test(err?.message || '')) {
			log.warn('glb_opt_schema_failed', { message: err?.message });
		}
		schemaReady = true;
	}
}

// Pick the heaviest public GLB over the budget that hasn't been analyzed within
// ANALYZE_TTL_DAYS. Returns { id, slug, name, storage_key, size_bytes } or null.
export async function pickTarget() {
	// Without a public R2 domain we cannot hand optimize_model a fetchable URL.
	if (!env.S3_PUBLIC_DOMAIN) return null;
	const rows = await sql`
		SELECT a.id, a.slug, a.name, a.storage_key, a.size_bytes
		FROM avatars a
		LEFT JOIN glb_optimizations g
			ON g.avatar_id = a.id
			AND g.analyzed_at > now() - (${ANALYZE_TTL_DAYS} || ' days')::interval
		WHERE a.deleted_at IS NULL
			AND a.visibility = 'public'
			AND a.storage_key IS NOT NULL
			AND a.storage_key ILIKE '%.glb'
			AND a.size_bytes > ${SIZE_THRESHOLD_BYTES}
			AND g.id IS NULL
		ORDER BY a.size_bytes DESC
		LIMIT 1
	`;
	return rows[0] || null;
}

// Project the post-optimization size from the model's *measured* stats. Pure,
// deterministic, and side-effect-free so it is independently testable.
export function projectOptimization(info, originalBytes) {
	const counts = info?.counts || {};
	const textures = Array.isArray(info?.textures) ? info.textures : [];
	const extensions = Array.isArray(info?.extensionsUsed) ? info.extensionsUsed : [];

	const fileSize = Number(info?.fileSize) || Number(originalBytes) || 0;
	const vertices = Number(counts.totalVertices) || 0;
	const triangles = Number(counts.totalTriangles) || 0;

	// ── Geometry ──────────────────────────────────────────────────────────────
	const geomBytes = vertices * BYTES_PER_VERTEX;
	const alreadyCompressed =
		extensions.includes('KHR_draco_mesh_compression') ||
		extensions.includes('EXT_meshopt_compression');
	const geomAfter = alreadyCompressed ? geomBytes : Math.round(geomBytes * GEOM_RETAINED_DRACO);

	// ── Textures ──────────────────────────────────────────────────────────────
	let textureBytes = 0;
	let textureAfter = 0;
	for (const t of textures) {
		const byteSize = Number(t?.byteSize) || 0;
		textureBytes += byteSize;
		if (byteSize <= 0) continue;
		const maxDim = Math.max(Number(t?.width) || 0, Number(t?.height) || 0);
		// Downscale oversized textures to the web target; area scales by the square.
		let after = byteSize;
		if (maxDim > TARGET_TEXTURE_DIM) {
			const ratio = (TARGET_TEXTURE_DIM / maxDim) ** 2;
			after = after * ratio;
		}
		// KTX2 / Basis transcode — already-compressed GPU formats are left as-is.
		const mime = String(t?.mimeType || '').toLowerCase();
		if (mime === 'image/png') after *= KTX2_RETAINED_PNG;
		else if (mime === 'image/jpeg' || mime === 'image/jpg') after *= KTX2_RETAINED_JPEG;
		textureAfter += after;
	}
	textureAfter = Math.round(textureAfter);

	// ── Everything else (animations, accessors, JSON) — left unchanged ─────────
	const otherBytes = Math.max(0, fileSize - geomBytes - textureBytes);

	let optimized = geomAfter + textureAfter + otherBytes;
	// Sanity clamp: a real-world re-encode rarely drops a complex model below 10%
	// of its original weight, and can never exceed it.
	optimized = Math.min(fileSize, Math.max(optimized, Math.round(fileSize * 0.10)));

	const savings = Math.max(0, fileSize - optimized);
	const savingsPct = fileSize > 0 ? (savings / fileSize) * 100 : 0;

	const loadBeforeMs = Math.round((fileSize / REFERENCE_BYTES_PER_SEC) * 1000);
	const loadAfterMs = Math.round((optimized / REFERENCE_BYTES_PER_SEC) * 1000);
	const loadImprovementPct = loadBeforeMs > 0 ? ((loadBeforeMs - loadAfterMs) / loadBeforeMs) * 100 : 0;

	return {
		fileSize,
		vertices,
		triangles,
		textureCount: textures.length,
		textureBytes,
		alreadyCompressed,
		estimatedOptimizedBytes: optimized,
		estimatedSavingsBytes: savings,
		savingsPct: Number(savingsPct.toFixed(2)),
		loadBeforeMs,
		loadAfterMs,
		loadImprovementPct: Number(loadImprovementPct.toFixed(2)),
	};
}

// Build the MCP JSON-RPC tools/call body for optimize_model.
function buildMcpBody(modelUrl) {
	return {
		jsonrpc: '2.0',
		id: randomUUID(),
		method: 'tools/call',
		params: { name: 'optimize_model', arguments: { url: modelUrl } },
	};
}

// Pull { suggestions, info } out of the (possibly batched) MCP response.
function parseOptimizeResult(responseBody) {
	const msg = Array.isArray(responseBody) ? responseBody[0] : responseBody;
	const sc = msg?.result?.structuredContent;
	if (sc && (sc.info || sc.suggestions)) {
		return { suggestions: Array.isArray(sc.suggestions) ? sc.suggestions : [], info: sc.info || null };
	}
	return null;
}

async function recordDetailRow(runId, fields) {
	const {
		serviceName, endpointUrl, amountAtomic, txSig, responseData,
		valueExtracted, durationMs, success, errorMsg,
	} = fields;
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
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'3d'})
		`;
	} catch (err) {
		log.warn('glb_opt_log_insert_failed', { message: err?.message });
	}
}

async function persistOptimization(runId, target, modelUrl, parsed, projection, amountAtomic, txSig) {
	const suggestionIds = parsed.suggestions.map((s) => s?.id).filter(Boolean);
	await sql`
		INSERT INTO glb_optimizations
			(avatar_id, slug, name, source_url, original_bytes,
			 estimated_optimized_bytes, estimated_savings_bytes, savings_pct,
			 load_ms_before, load_ms_after, load_improvement_pct,
			 triangles, vertices, texture_count, texture_bytes,
			 suggestion_ids, suggestions, info, run_id, tx_signature, amount_atomic)
		VALUES
			(${target.id}, ${target.slug}, ${target.name}, ${modelUrl}, ${projection.fileSize},
			 ${projection.estimatedOptimizedBytes}, ${projection.estimatedSavingsBytes}, ${projection.savingsPct},
			 ${projection.loadBeforeMs}, ${projection.loadAfterMs}, ${projection.loadImprovementPct},
			 ${projection.triangles}, ${projection.vertices}, ${projection.textureCount}, ${projection.textureBytes},
			 ${suggestionIds}, ${JSON.stringify(parsed.suggestions)}, ${JSON.stringify(parsed.info)},
			 ${runId}, ${txSig || null}, ${amountAtomic || 0})
	`;
}

/**
 * Run the optimizer: pick a heavy GLB, pay the optimize_model call, project the
 * savings, and persist. Never throws — every fault is caught, logged, recorded,
 * and returned as a structured outcome for the loop's summary row.
 *
 * @param {object} [ctx] loop-supplied payment context. When buyer/conn/blockhash
 *   /mintInfo are absent (manual test) the context is bootstrapped here.
 * @returns {Promise<object>} { success, amountAtomic, txSig, responseData,
 *   signalData, skipped, note, errorMsg }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const endpointUrl = `${origin}/api/mcp`;
	const remainingCap = Number.isFinite(ctx.remainingCap) ? ctx.remainingCap : Infinity;
	const t0 = Date.now();

	try {
		await ensureOptimizationSchema();
	} catch { /* ensureOptimizationSchema already swallows */ }

	// 1. Pick a target. No heavy GLB → nothing to do (no payment, no error).
	let target;
	try {
		target = await pickTarget();
	} catch (err) {
		log.warn('glb_opt_target_query_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `target_query_failed: ${err?.message}` };
	}
	if (!target) {
		return { success: true, skipped: true, amountAtomic: 0, note: 'no_oversized_glb', responseData: { reason: 'catalog_clear' } };
	}

	const modelUrl = publicUrl(target.storage_key);
	const serviceName = `GLB Size Optimizer: ${target.name || target.slug || target.id}`;

	// 2. Ensure we have a payment context (bootstrap when called standalone).
	let buyer = ctx.buyer, conn = ctx.conn, blockhash = ctx.blockhash, mintInfo = ctx.mintInfo;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			loadSeedKeypair(); // fail fast + clearly if the wallet is unconfigured
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext());
		} catch (err) {
			log.info('glb_opt_skipped', { reason: err?.message });
			await recordDetailRow(runId, {
				serviceName, endpointUrl, amountAtomic: 0, txSig: null, responseData: null,
				valueExtracted: null, durationMs: Date.now() - t0, success: false,
				errorMsg: err?.message || 'wallet_or_rpc_unconfigured',
			});
			return { success: false, skipped: true, amountAtomic: 0, errorMsg: err?.message, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	// 3. Pay the optimize_model call (real on-chain x402).
	let result;
	try {
		result = await payX402({
			url: endpointUrl,
			method: 'POST',
			body: buildMcpBody(modelUrl),
			buyer, conn, blockhash, mintInfo,
			remainingCap,
			userAgent: 'threews-glb-optimizer/1.0',
		});
	} catch (err) {
		await recordDetailRow(runId, {
			serviceName, endpointUrl, amountAtomic: 0, txSig: null, responseData: null,
			valueExtracted: null, durationMs: Date.now() - t0, success: false,
			errorMsg: err?.message || 'pay_failed',
		});
		return { success: false, skipped: false, amountAtomic: 0, errorMsg: err?.message || 'pay_failed' };
	}

	const parsed = result.success ? parseOptimizeResult(result.responseBody) : null;

	// 4. On a successful, parseable response: project + persist the value.
	if (result.success && parsed?.info) {
		let projection;
		try {
			projection = projectOptimization(parsed.info, target.size_bytes);
			await persistOptimization(runId, target, modelUrl, parsed, projection, result.amountAtomic, result.txSig);
		} catch (err) {
			log.warn('glb_opt_persist_failed', { id: target.id, message: err?.message });
		}

		const valueExtracted = projection ? {
			avatar_id: target.id,
			slug: target.slug,
			original_bytes: projection.fileSize,
			estimated_optimized_bytes: projection.estimatedOptimizedBytes,
			estimated_savings_bytes: projection.estimatedSavingsBytes,
			savings_pct: projection.savingsPct,
			load_improvement_pct: projection.loadImprovementPct,
			suggestions: parsed.suggestions.map((s) => s?.id).filter(Boolean),
			already_compressed: projection.alreadyCompressed,
		} : null;

		await recordDetailRow(runId, {
			serviceName, endpointUrl, amountAtomic: result.amountAtomic, txSig: result.txSig,
			responseData: { status: result.status, filename: parsed.info?.filename, suggestion_count: parsed.suggestions.length },
			valueExtracted, durationMs: Date.now() - t0, success: true, errorMsg: null,
		});

		log.info('glb_opt_complete', {
			run_id: runId, avatar_id: target.id, original_mb: (projection?.fileSize / 1048576).toFixed(2),
			savings_pct: projection?.savingsPct, amount_usdc: (result.amountAtomic / 1e6).toFixed(4),
		});

		return {
			success: true,
			amountAtomic: result.amountAtomic,
			txSig: result.txSig,
			responseData: { avatar_id: target.id, slug: target.slug, ...valueExtracted },
			signalData: valueExtracted,
			note: projection
				? `glb_optimizer saved≈${projection.savingsPct}% (${(projection.estimatedSavingsBytes / 1048576).toFixed(1)}MB) on ${target.slug || target.id}`
				: 'optimize_model ok (no projection)',
		};
	}

	// 5. Paid but unparseable, or the call failed / was rejected / capped.
	const errorMsg = result.errorMsg || (parsed ? 'no_inspection_info' : 'unparseable_response');
	await recordDetailRow(runId, {
		serviceName, endpointUrl, amountAtomic: result.amountAtomic || 0, txSig: result.txSig,
		responseData: result.responseBody ? { status: result.status, error: result.responseBody?.error || null } : null,
		valueExtracted: null, durationMs: Date.now() - t0, success: false, errorMsg,
	});
	return {
		success: false,
		skipped: !!result.skipped,
		amountAtomic: result.amountAtomic || 0,
		txSig: result.txSig || null,
		errorMsg,
		note: result.skipped ? `skipped:${errorMsg}` : undefined,
	};
}

/**
 * Downstream read: catalog-wide optimization summary. Consumed by
 * GET /api/x402/glb-optimization-report.
 *
 * Reports the average projected size + load-time improvement across every model
 * analyzed in the window, the total bytes the catalog would shed, and the
 * remaining backlog of heavy GLBs not yet analyzed.
 */
export async function readCatalogOptimizationSummary({ windowDays = 90, limit = 25 } = {}) {
	await ensureOptimizationSchema();

	// Latest analysis per avatar within the window.
	const latest = await sql`
		SELECT DISTINCT ON (avatar_id)
			avatar_id, slug, name, source_url, original_bytes,
			estimated_optimized_bytes, estimated_savings_bytes, savings_pct,
			load_ms_before, load_ms_after, load_improvement_pct,
			suggestion_ids, analyzed_at
		FROM glb_optimizations
		WHERE analyzed_at > now() - (${windowDays} || ' days')::interval
		ORDER BY avatar_id, analyzed_at DESC
	`;

	const analyzedCount = latest.length;
	const totalOriginal = latest.reduce((s, r) => s + Number(r.original_bytes || 0), 0);
	const totalOptimized = latest.reduce((s, r) => s + Number(r.estimated_optimized_bytes || 0), 0);
	const totalSavings = Math.max(0, totalOriginal - totalOptimized);
	const avgSavingsPct = analyzedCount
		? latest.reduce((s, r) => s + Number(r.savings_pct || 0), 0) / analyzedCount : 0;
	const avgLoadImprovementPct = analyzedCount
		? latest.reduce((s, r) => s + Number(r.load_improvement_pct || 0), 0) / analyzedCount : 0;

	// Remaining backlog of oversized, not-recently-analyzed GLBs.
	let backlog = 0;
	try {
		const [row] = await sql`
			SELECT count(*)::int AS n
			FROM avatars a
			LEFT JOIN glb_optimizations g
				ON g.avatar_id = a.id
				AND g.analyzed_at > now() - (${ANALYZE_TTL_DAYS} || ' days')::interval
			WHERE a.deleted_at IS NULL
				AND a.visibility = 'public'
				AND a.storage_key IS NOT NULL
				AND a.storage_key ILIKE '%.glb'
				AND a.size_bytes > ${SIZE_THRESHOLD_BYTES}
				AND g.id IS NULL
		`;
		backlog = row?.n || 0;
	} catch { /* avatars table absent in some envs */ }

	const top = latest
		.slice()
		.sort((a, b) => Number(b.estimated_savings_bytes || 0) - Number(a.estimated_savings_bytes || 0))
		.slice(0, limit)
		.map((r) => ({
			avatar_id: r.avatar_id,
			slug: r.slug,
			name: r.name,
			original_bytes: Number(r.original_bytes),
			estimated_optimized_bytes: Number(r.estimated_optimized_bytes),
			estimated_savings_bytes: Number(r.estimated_savings_bytes),
			savings_pct: Number(r.savings_pct),
			load_ms_before: r.load_ms_before,
			load_ms_after: r.load_ms_after,
			load_improvement_pct: Number(r.load_improvement_pct),
			suggestions: r.suggestion_ids || [],
			analyzed_at: r.analyzed_at,
		}));

	return {
		ok: true,
		window_days: windowDays,
		analyzed_count: analyzedCount,
		backlog_count: backlog,
		total_original_bytes: totalOriginal,
		total_optimized_bytes: totalOptimized,
		total_savings_bytes: totalSavings,
		total_savings_mb: Number((totalSavings / 1048576).toFixed(2)),
		avg_savings_pct: Number(avgSavingsPct.toFixed(2)),
		avg_load_improvement_pct: Number(avgLoadImprovementPct.toFixed(2)),
		reference_bandwidth_bytes_per_sec: REFERENCE_BYTES_PER_SEC,
		models: top,
	};
}

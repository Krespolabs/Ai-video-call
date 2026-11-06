// api/_lib/x402/pipelines/rig-complexity.js
//
// Rig Complexity Scorer — autonomous pipeline (self/017).
//
// On each run it scores a small batch of avatars that have never been scored or
// whose GLB changed since the last score. For each avatar it pays the advertised
// price ($0.01 USDC) to call inspect_model on the three.ws MCP server
// (/api/mcp) — a real on-chain USDC payment from the seed wallet, never mocked —
// then derives a 0-100 complexity score from the returned structure (bone count,
// vertex count, texture bytes, triangles, file size) and a performance tier.
//
// The pipeline:
//   1. Selects avatars needing a score (new or GLB-changed) from `avatars`.
//   2. Probes + pays inspect_model for each (real x402; degrades gracefully when
//      the wallet is unconfigured, the RPC is down, or a single call fails).
//   3. Upserts the score + tier + raw metrics into `avatar_complexity`.
//   4. Records one row per call in x402_autonomous_log (success OR failure),
//      with the parsed score in value_extracted.
//
// Downstream consumer: `avatar_complexity` is read by the Avatar Pricing Engine
// (self/020) to tier marketplace listing prices, and by the marketplace gallery
// to surface a "performance-heavy" warning badge on avatars whose perf_warning
// flag is set. Keyed by avatar_id so any avatar surface can join against it.
//
// Real on-chain payments only — no mocks, no simulations.

import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { publicUrl } from '../../r2.js';
import { solanaConnection } from '../../solana/connection.js';
import { logger } from '../../usage.js';
import { loadSeedKeypair, payX402 } from '../pay.js';

const log = logger('x402-rig-complexity');

const USDC_MINT = () => env.X402_ASSET_MINT_SOLANA || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// How many avatars to score per run. With the registry cooldown (1h) this drains
// any backlog steadily while bounding spend (≤ BATCH × $0.01 per run); at steady
// state only newly-uploaded or changed avatars qualify, so most runs do nothing.
const BATCH = Number(process.env.X402_RIG_COMPLEXITY_BATCH || 4);

// ── Complexity model ──────────────────────────────────────────────────────────
// Per-dimension "full budget" for a web-delivered avatar. A value at budget
// contributes its full weight; the ratio is allowed to run to 2× so a single
// runaway dimension can still pull the score up before the final 0-100 clamp.
const BUDGETS = Object.freeze({
	vertices: 150_000,
	triangles: 300_000,
	textureBytes: 16 * 1024 * 1024, // 16 MB decoded
	bones: 120,
	fileBytes: 30 * 1024 * 1024, // 30 MB
});

const WEIGHTS = Object.freeze({
	vertices: 0.30,
	triangles: 0.20,
	textureBytes: 0.25,
	bones: 0.10,
	fileBytes: 0.15,
});

// Hard ceilings that flag an avatar as performance-heavy regardless of the
// blended score (one pathological dimension is enough to stutter on mobile).
const HARD_LIMITS = Object.freeze({
	vertices: 500_000,
	triangles: 1_000_000,
	textureBytes: 48 * 1024 * 1024,
	maxTextureDim: 8192,
	fileBytes: 75 * 1024 * 1024,
	bones: 256,
});

function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}

function tierForScore(score) {
	if (score < 25) return 'light';
	if (score < 50) return 'standard';
	if (score < 75) return 'heavy';
	return 'extreme';
}

// Pure: turn an inspect_model structuredContent payload into a complexity record.
// Exported so it can be unit-tested without any network or DB.
export function computeComplexity(info, { fileBytes = 0 } = {}) {
	const counts = info?.counts || {};
	const textures = Array.isArray(info?.textures) ? info.textures : [];

	const boneCount = Number(counts.totalJoints || 0);
	const vertexCount = Number(counts.totalVertices || 0);
	const triangleCount = Number(counts.totalTriangles || 0);
	const textureBytes = textures.reduce((a, t) => a + Number(t?.byteSize || 0), 0);
	const maxTextureDim = textures.reduce(
		(m, t) => Math.max(m, Number(t?.width || 0), Number(t?.height || 0)),
		0,
	);
	// inspect_model reports fileSize; fall back to the DB size_bytes when absent.
	const fileSize = Number(info?.fileSize || fileBytes || 0);

	const dims = {
		vertices: vertexCount,
		triangles: triangleCount,
		textureBytes,
		bones: boneCount,
		fileBytes: fileSize,
	};

	const breakdown = {};
	let score = 0;
	for (const key of Object.keys(WEIGHTS)) {
		const budget = BUDGETS[key];
		const ratio = budget > 0 ? clamp(dims[key] / budget, 0, 2) : 0;
		const weighted = ratio * WEIGHTS[key] * 100;
		score += weighted;
		breakdown[key] = {
			value: dims[key],
			budget,
			ratio: Number(ratio.toFixed(3)),
			weighted: Number(weighted.toFixed(2)),
		};
	}
	score = Number(clamp(score, 0, 100).toFixed(2));

	const overHardLimit =
		vertexCount > HARD_LIMITS.vertices ||
		triangleCount > HARD_LIMITS.triangles ||
		textureBytes > HARD_LIMITS.textureBytes ||
		maxTextureDim >= HARD_LIMITS.maxTextureDim ||
		fileSize > HARD_LIMITS.fileBytes ||
		boneCount > HARD_LIMITS.bones;

	const tier = tierForScore(score);
	const perfWarning = overHardLimit || tier === 'heavy' || tier === 'extreme';

	return {
		bone_count: boneCount,
		vertex_count: vertexCount,
		triangle_count: triangleCount,
		texture_bytes: textureBytes,
		texture_count: textures.length,
		max_texture_dim: maxTextureDim,
		file_bytes: fileSize,
		mesh_count: Number(counts.meshes || 0),
		material_count: Number(counts.materials || 0),
		skin_count: Number(counts.skins || 0),
		complexity_score: score,
		tier,
		perf_warning: perfWarning,
		breakdown,
	};
}

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _schemaReady = false;
async function ensureSchema() {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS avatar_complexity (
			avatar_id         uuid PRIMARY KEY REFERENCES avatars(id) ON DELETE CASCADE,
			model_url         text,
			bone_count        int NOT NULL DEFAULT 0,
			vertex_count      bigint NOT NULL DEFAULT 0,
			triangle_count    bigint NOT NULL DEFAULT 0,
			texture_bytes     bigint NOT NULL DEFAULT 0,
			texture_count     int NOT NULL DEFAULT 0,
			max_texture_dim   int NOT NULL DEFAULT 0,
			file_bytes        bigint NOT NULL DEFAULT 0,
			mesh_count        int NOT NULL DEFAULT 0,
			material_count    int NOT NULL DEFAULT 0,
			skin_count        int NOT NULL DEFAULT 0,
			complexity_score  numeric(6,2) NOT NULL DEFAULT 0,
			tier              text NOT NULL DEFAULT 'light'
				CHECK (tier IN ('light','standard','heavy','extreme')),
			perf_warning      boolean NOT NULL DEFAULT false,
			breakdown         jsonb,
			source_updated_at timestamptz,
			run_id            uuid,
			scored_at         timestamptz DEFAULT now()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS avatar_complexity_tier_idx ON avatar_complexity (tier, complexity_score DESC)`;
	await sql`CREATE INDEX IF NOT EXISTS avatar_complexity_warn_idx ON avatar_complexity (perf_warning) WHERE perf_warning`;
	// The autonomous log predates this pipeline; add the value_extracted column it
	// records the parsed score into (idempotent — shared with sibling pipelines).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

// Avatars that need (re)scoring: never scored, or whose GLB changed since the
// last score. New avatars first, then the stalest. Scoped to marketplace-visible
// avatars with a GLB storage key (the rows whose pricing/badge actually consume
// the result, and whose objects are publicly fetchable by inspect_model).
async function selectAvatarsToScore(limit) {
	return sql`
		SELECT a.id, a.slug, a.name, a.storage_key, a.size_bytes, a.updated_at
		FROM avatars a
		LEFT JOIN avatar_complexity c ON c.avatar_id = a.id
		WHERE a.deleted_at IS NULL
		  AND a.visibility IN ('public', 'unlisted')
		  AND a.storage_key ILIKE '%.glb'
		  AND (c.avatar_id IS NULL OR c.source_updated_at IS DISTINCT FROM a.updated_at)
		ORDER BY (c.avatar_id IS NULL) DESC, c.scored_at ASC NULLS FIRST, a.updated_at DESC
		LIMIT ${limit}
	`;
}

async function upsertComplexity(avatarId, modelUrl, sourceUpdatedAt, runId, c) {
	await sql`
		INSERT INTO avatar_complexity
			(avatar_id, model_url, bone_count, vertex_count, triangle_count,
			 texture_bytes, texture_count, max_texture_dim, file_bytes,
			 mesh_count, material_count, skin_count, complexity_score, tier,
			 perf_warning, breakdown, source_updated_at, run_id, scored_at)
		VALUES
			(${avatarId}, ${modelUrl}, ${c.bone_count}, ${c.vertex_count}, ${c.triangle_count},
			 ${c.texture_bytes}, ${c.texture_count}, ${c.max_texture_dim}, ${c.file_bytes},
			 ${c.mesh_count}, ${c.material_count}, ${c.skin_count}, ${c.complexity_score}, ${c.tier},
			 ${c.perf_warning}, ${JSON.stringify(c.breakdown)}, ${sourceUpdatedAt}, ${runId}, now())
		ON CONFLICT (avatar_id) DO UPDATE SET
			model_url         = EXCLUDED.model_url,
			bone_count        = EXCLUDED.bone_count,
			vertex_count      = EXCLUDED.vertex_count,
			triangle_count    = EXCLUDED.triangle_count,
			texture_bytes     = EXCLUDED.texture_bytes,
			texture_count     = EXCLUDED.texture_count,
			max_texture_dim   = EXCLUDED.max_texture_dim,
			file_bytes        = EXCLUDED.file_bytes,
			mesh_count        = EXCLUDED.mesh_count,
			material_count    = EXCLUDED.material_count,
			skin_count        = EXCLUDED.skin_count,
			complexity_score  = EXCLUDED.complexity_score,
			tier              = EXCLUDED.tier,
			perf_warning      = EXCLUDED.perf_warning,
			breakdown         = EXCLUDED.breakdown,
			source_updated_at = EXCLUDED.source_updated_at,
			run_id            = EXCLUDED.run_id,
			scored_at         = now()
	`;
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
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'3d'})
		`;
	} catch (err) {
		log.warn('rig_complexity_log_insert_failed', { message: err?.message });
	}
}

function inspectBody(modelUrl, id) {
	return {
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name: 'inspect_model', arguments: { url: modelUrl } },
	};
}

// Pull inspect_model's structuredContent out of a JSON-RPC tools/call response.
function extractInspect(responseBody) {
	const rpcError = responseBody?.error || responseBody?.result?.isError || null;
	const sc = responseBody?.result?.structuredContent;
	if (!sc || !sc.counts) return { info: null, rpcError };
	return { info: sc, rpcError };
}

/**
 * Run the scorer. Self-contained: builds its own Solana payment context when the
 * cron loop doesn't supply one, so it can be invoked directly (manual test) or
 * handed the loop's shared blockhash + keypair. Records its own log rows, so it
 * returns { recorded: true } and the loop skips its generic recordLog.
 *
 * @param {object} [ctx]
 * @param {string}  [ctx.runId]        correlation id (defaults to a fresh uuid)
 * @param {string}  [ctx.origin]       base origin for /api/mcp
 * @param {object}  [ctx.buyer]        seed keypair (loaded if absent)
 * @param {object}  [ctx.conn]         Solana connection (created if absent)
 * @param {string}  [ctx.blockhash]    recent blockhash (fetched if absent)
 * @param {object}  [ctx.mintInfo]     USDC mint info (fetched if absent)
 * @param {number}  [ctx.remainingCap] spend ceiling for this run (atomics)
 * @returns {Promise<object>} loop-compatible outcome
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const endpointUrl = `${origin}/api/mcp`;
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
			log.info('rig_complexity_skipped', { reason: err.message });
			return fail(err.message);
		}
	}

	try {
		await ensureSchema();
	} catch (err) {
		log.warn('rig_complexity_schema_failed', { message: err?.message });
		return fail(`schema_failed: ${err?.message}`);
	}

	let targets;
	try {
		targets = await selectAvatarsToScore(BATCH);
	} catch (err) {
		log.warn('rig_complexity_select_failed', { message: err?.message });
		return fail(`select_failed: ${err?.message}`);
	}
	if (!targets.length) {
		return { ok: true, recorded: true, skipped: false, success: true, amountAtomic: 0, txSig: null, note: 'no_avatars_due', scored: 0 };
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
			log.warn('rig_complexity_solana_preflight_failed', { message: err?.message });
			return fail(`solana_preflight_failed: ${err?.message}`);
		}
	}

	let spentAtomic = 0;
	let paid = 0;
	let scored = 0;
	let lastTxSig = null;
	const summaries = [];

	for (let i = 0; i < targets.length; i++) {
		if (remainingCap <= 0) {
			log.info('rig_complexity_cap_reached', { spent_atomic: spentAtomic });
			break;
		}
		const a = targets[i];
		const modelUrl = publicUrl(a.storage_key);
		const serviceName = `Rig Complexity: ${a.slug || a.id}`;
		const t0 = Date.now();

		let result;
		try {
			result = await payX402({
				url: endpointUrl,
				method: 'POST',
				body: inspectBody(modelUrl, i + 1),
				conn, buyer, blockhash, mintInfo,
				remainingCap,
				// Distinct priority fee per avatar so several same-amount payments on
				// the one shared blockhash compile to distinct signatures.
				nonce: i + 1,
			});
		} catch (err) {
			// Network failure / abort — record the attempt, never crash the loop.
			await recordCall(runId, {
				serviceName, endpointUrl, amountAtomic: 0, txSig: null,
				responseData: { model_url: modelUrl },
				durationMs: Date.now() - t0, success: false,
				errorMsg: err?.message || 'fetch_failed', valueExtracted: null,
			});
			summaries.push({ avatar: a.slug || a.id, error: err?.message || 'fetch_failed' });
			continue;
		}

		// payX402 returns booleans (paid/free/skipped); derive a label for logging.
		const statusLabel = result.paid ? 'paid' : result.free ? 'free' : result.skipped ? 'skip' : 'error';
		if (result.paid) {
			spentAtomic += result.amountAtomic;
			remainingCap -= result.amountAtomic;
			paid += 1;
			lastTxSig = result.txSig || lastTxSig;
		}

		const { info, rpcError } = extractInspect(result.responseBody);
		let valueExtracted = null;
		let errorMsg = result.errorMsg;

		if (result.success && info) {
			const complexity = computeComplexity(info, { fileBytes: Number(a.size_bytes || 0) });
			try {
				await upsertComplexity(a.id, modelUrl, a.updated_at, runId, complexity);
				scored += 1;
			} catch (err) {
				errorMsg = `db_upsert_failed: ${err?.message}`;
				log.warn('rig_complexity_upsert_failed', { avatar: a.id, message: err?.message });
			}
			valueExtracted = {
				avatar_id: a.id,
				score: complexity.complexity_score,
				tier: complexity.tier,
				perf_warning: complexity.perf_warning,
				bones: complexity.bone_count,
				vertices: complexity.vertex_count,
				triangles: complexity.triangle_count,
				texture_bytes: complexity.texture_bytes,
			};
			summaries.push({ avatar: a.slug || a.id, ...valueExtracted });
		} else {
			if (!errorMsg) errorMsg = rpcError ? 'rpc_error' : 'no_inspect_data';
			summaries.push({ avatar: a.slug || a.id, status: statusLabel, error: errorMsg });
		}

		await recordCall(runId, {
			serviceName,
			endpointUrl,
			amountAtomic: result.amountAtomic,
			txSig: result.txSig,
			// Keep the log row slim — the parsed score lives in value_extracted.
			responseData: { model_url: modelUrl, status: statusLabel, rpc_error: result.responseBody?.error || null },
			durationMs: Date.now() - t0,
			success: result.success && !!info && !errorMsg,
			errorMsg: result.success && info && !errorMsg ? null : errorMsg,
			valueExtracted,
		});
	}

	const heavy = summaries.filter((s) => s.perf_warning).length;
	log.info('rig_complexity_complete', {
		run_id: runId,
		candidates: targets.length,
		scored,
		paid,
		heavy,
		spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	return {
		ok: true,
		recorded: true,
		skipped: false,
		success: scored > 0 || paid > 0,
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		signalData: { scored, paid, heavy, candidates: targets.length },
		note: `scored ${scored}/${targets.length}`,
		scored,
		paid,
		summaries,
	};
}

// api/_lib/x402/granite-health.js
//
// IBM Granite Inference Health Check — the canary batch, response summariser,
// and value store for the `granite-inference-health` autonomous-loop entry
// (autonomous-registry.js).
//
// The autonomous loop makes ONE real x402-paid call to /api/ibm-mcp per tick: a
// single JSON-RPC batch that invokes all five paid IBM Granite tools (chat, code,
// embed, analyze, forecast) with tiny canary arguments. One payment settles the
// summed price of the batch (the IBM MCP server prices the whole request), and
// the loop records that paid round-trip to x402_autonomous_log like every other
// call. This module is the "extract and store value" stage:
//
//   • summarizeGraniteHealth(responseBody) — parses the batch response, verifies
//     each tool answered with its expected schema, and tallies token throughput.
//     Wired as the entry's extractSignal → x402_autonomous_log.signal_data.
//   • storeGraniteHealth(ctx) — upserts the per-tool verdict + throughput into
//     `granite_inference_health`. Wired as the entry's storeValue.
//   • readGraniteHealth() — the downstream read, consumed by
//     GET /api/x402/granite-health (the watsonx backend SLA dashboard feed).
//
// Why a paid batch rather than five separate calls: the IBM MCP server charges
// the per-request total of every priced tools/call in the body, so a single
// batched request exercises the full watsonx inference surface for one on-chain
// payment (and one signed transaction) instead of five.

import { sql } from '../db.js';
import { logger } from '../usage.js';
import { payX402, bootstrapSolanaContext } from './pay.js';

const log = logger('granite-health');

// One paid batch covers all five tools; this is the advertised sum the IBM MCP
// server charges (chat 0.02 + code 0.025 + embed 0.005 + analyze 0.04 +
// forecast 0.05 = 0.14 USDC). The real amount paid still comes from the live 402
// challenge — this is the budgeting/expectation value the registry advertises.
export const GRANITE_HEALTH_PRICE_ATOMIC = 140_000;
export const GRANITE_HEALTH_ENDPOINT = '/api/ibm-mcp';

export const GRANITE_SERVER = 'ibm-x402-mcp';

// The five paid Granite tools this health check exercises, in batch order. The
// JSON-RPC request `id` for each message is the tool name, so the summariser can
// match responses back to tools regardless of server-side ordering.
export const GRANITE_HEALTH_TOOLS = Object.freeze([
	'ibm_granite_chat',
	'ibm_granite_code',
	'ibm_granite_embed',
	'ibm_granite_analyze',
	'ibm_granite_forecast',
]);

// Granite TTM (forecast) zero-shot models need a full context window; the
// smallest, ibm/granite-ttm-512-96-r2, expects 512 history points. Send exactly
// that so the canary forecast is a valid call rather than a context-underflow
// false negative. Generated once at module load.
const FORECAST_CONTEXT = 512;
const FORECAST_CANARY = (() => {
	// A deterministic synthetic hourly series (gentle trend + daily seasonality).
	// Anchored to a fixed epoch so the payload is identical on every run/instance.
	const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
	const hourMs = 3_600_000;
	const timestamps = new Array(FORECAST_CONTEXT);
	const values = new Array(FORECAST_CONTEXT);
	for (let i = 0; i < FORECAST_CONTEXT; i++) {
		timestamps[i] = new Date(startMs + i * hourMs).toISOString();
		values[i] = Number((100 + i * 0.05 + 8 * Math.sin((i / 24) * 2 * Math.PI)).toFixed(4));
	}
	return { timestamps, values, freq: '1h', prediction_length: 12, label: 'granite_health_canary' };
})();

// One JSON-RPC tools/call message per tool, each with minimal valid arguments.
// Generative tools cap their output (max_new_tokens / short prompts) so the
// canary stays cheap to run and small to store. `id === tool name` is what the
// summariser keys on.
function graniteHealthMessage(toolName) {
	const base = { jsonrpc: '2.0', id: toolName, method: 'tools/call' };
	switch (toolName) {
		case 'ibm_granite_chat':
			return {
				...base,
				params: {
					name: toolName,
					arguments: {
						messages: [{ role: 'user', content: 'Health check. Reply with the single word: OK.' }],
						max_new_tokens: 8,
						temperature: 0,
					},
				},
			};
		case 'ibm_granite_code':
			return {
				...base,
				params: {
					name: toolName,
					arguments: {
						task: 'explain',
						prompt: 'function add(a, b) { return a + b; }',
						language: 'JavaScript',
					},
				},
			};
		case 'ibm_granite_embed':
			return {
				...base,
				params: { name: toolName, arguments: { inputs: ['health check canary'] } },
			};
		case 'ibm_granite_analyze':
			return {
				...base,
				params: {
					name: toolName,
					arguments: {
						document: 'System health check ping. All subsystems nominal. No action required.',
						analysis_type: 'general',
					},
				},
			};
		case 'ibm_granite_forecast':
			return {
				...base,
				params: { name: toolName, arguments: { ...FORECAST_CANARY } },
			};
		default:
			return { ...base, params: { name: toolName, arguments: {} } };
	}
}

// The full batch body the autonomous-loop entry sends as its `body`. Built once.
export const GRANITE_HEALTH_BATCH = GRANITE_HEALTH_TOOLS.map(graniteHealthMessage);

/**
 * Run the IBM Granite inference health check: pay ONE real x402 batch call to
 * /api/ibm-mcp exercising all five Granite tools, summarise the response, and
 * persist the verdict to granite_inference_health.
 *
 * Wired as the `granite-inference-health` registry entry's run(). The autonomous
 * loop hands it { origin, buyer, conn, blockhash, mintInfo, redis, sql, log,
 * runId, remainingCap } and records the returned aggregate to x402_autonomous_log.
 * Also directly invocable for manual testing: with no Solana context in ctx it
 * bootstraps its own (loads the seed keypair, fetches a blockhash + mint).
 *
 * Never throws — every failure mode (wallet unconfigured, network timeout, 402
 * rejection, DB error) is caught and returned as a structured, recorded outcome
 * so the loop tick cannot crash.
 *
 * @param {object} [ctx] loop run() ctx (all fields optional for standalone use)
 * @returns {Promise<object>} { success, skipped, amountAtomic, txSig, errorMsg,
 *                              responseData, signalData, note }
 */
export async function runGraniteHealth(ctx = {}) {
	const ctxLog = ctx.log || log;
	const origin = ctx.origin || 'https://three.ws';
	const url = `${origin}${GRANITE_HEALTH_ENDPOINT}`;
	const dbClient = ctx.sql || sql;

	// Resolve the Solana payment context — reuse the loop's shared one, or
	// bootstrap a fresh context for a standalone/manual call. A missing seed
	// keypair surfaces here as a graceful skip (never a thrown tick).
	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			const boot = await bootstrapSolanaContext({ buyer });
			({ buyer, conn, blockhash, mintInfo } = boot);
		} catch (err) {
			ctxLog.warn('granite_health_wallet_unconfigured', { message: err?.message });
			return {
				success: false, skipped: true, amountAtomic: 0, txSig: null,
				errorMsg: err?.message || 'wallet_unconfigured',
				note: 'granite-health skipped: payer wallet not configured',
			};
		}
	}

	const t0 = Date.now();
	let pay;
	try {
		pay = await payX402({
			url, method: 'POST', body: GRANITE_HEALTH_BATCH,
			buyer, conn, blockhash, mintInfo,
			remainingCap: ctx.remainingCap ?? Infinity,
		});
	} catch (err) {
		// Network timeout / RPC failure / transport error.
		ctxLog.warn('granite_health_call_failed', { message: err?.message });
		return {
			success: false, skipped: false, amountAtomic: 0, txSig: null,
			errorMsg: err?.message || 'granite_call_failed',
			note: 'granite-health call failed before settlement',
		};
	}
	const durationMs = Date.now() - t0;

	const summary = summarizeGraniteHealth(pay.responseBody);

	// Extract + store value only when the call actually settled (or was free).
	if (pay.success) {
		try {
			await storeGraniteHealth({
				sql: dbClient, responseBody: pay.responseBody,
				signalData: summary, runId: ctx.runId, durationMs,
			});
		} catch (err) {
			// DB failure must not fail the paid call — it already succeeded on-chain.
			ctxLog.warn('granite_health_store_failed', { message: err?.message });
		}
	}

	const degraded = pay.success && summary.tools_failed > 0;
	return {
		success: pay.success,
		skipped: pay.skipped || false,
		amountAtomic: pay.success ? pay.amountAtomic : 0,
		txSig: pay.txSig || null,
		errorMsg: pay.errorMsg || (degraded ? `granite_tools_failed:${summary.tools_failed}` : null),
		responseData: { granite_health: summary, http_status: pay.status },
		signalData: summary,
		note: `granite ${summary.tools_ok}/${summary.tools_total} ok · ${summary.total_tokens} tok · ${durationMs}ms`,
	};
}

// Token usage is OpenAI-shaped on watsonx chat (prompt_tokens/completion_tokens/
// total_tokens). Read defensively in case a model returns the older
// input_token_count/generated_token_count naming.
function readUsage(structured) {
	const u = structured?.usage || {};
	const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? u.input_token_count ?? 0) || 0;
	const completion = Number(u.completion_tokens ?? u.output_tokens ?? u.generated_token_count ?? 0) || 0;
	const total = Number(u.total_tokens ?? (prompt + completion)) || prompt + completion;
	return { prompt, completion, total };
}

// Does a tool's structuredContent match the shape that tool is contracted to
// return? A 200 response with a malformed body is a backend regression even
// though the JSON-RPC envelope succeeded — so schema conformance is tracked
// separately from "did it answer".
function schemaOk(toolName, s) {
	if (!s || s.ok === false) return false;
	switch (toolName) {
		case 'ibm_granite_chat':
		case 'ibm_granite_code':
			return typeof s.text === 'string';
		case 'ibm_granite_embed':
			return Array.isArray(s.vectors) && Number(s.dimensions) > 0 && Number(s.inputCount) > 0;
		case 'ibm_granite_analyze':
			// Either a parsed analysis (summary) or the documented raw fallback.
			return typeof s.summary === 'string' || typeof s.raw_response === 'string';
		case 'ibm_granite_forecast':
			return Array.isArray(s.forecast) && Number(s.forecastSteps) > 0;
		default:
			return true;
	}
}

/**
 * Parse the batched /api/ibm-mcp response into a health summary.
 * Verifies every Granite tool answered with its expected schema and tallies
 * token throughput. Pure + defensive — never throws, accepts a single response
 * object or an array (JSON-RPC batch).
 *
 * @param {object|Array} responseBody
 * @returns {object} summary stored to signal_data and granite_inference_health
 */
export function summarizeGraniteHealth(responseBody) {
	const list = Array.isArray(responseBody) ? responseBody : (responseBody != null ? [responseBody] : []);
	// Index responses by JSON-RPC id (== tool name in our batch).
	const byId = new Map();
	for (const msg of list) {
		if (msg && msg.id != null) byId.set(String(msg.id), msg);
	}

	const perTool = {};
	let toolsOk = 0;
	let schemaOkCount = 0;
	let promptTokens = 0;
	let completionTokens = 0;
	let totalTokens = 0;
	let embedDimensions = 0;
	let embedInputs = 0;
	let forecastSteps = 0;

	for (const tool of GRANITE_HEALTH_TOOLS) {
		const msg = byId.get(tool);
		if (!msg) {
			perTool[tool] = { ok: false, schema_ok: false, error: 'no_response' };
			continue;
		}
		if (msg.error) {
			perTool[tool] = {
				ok: false,
				schema_ok: false,
				error: msg.error?.message || `rpc_error_${msg.error?.code ?? 'unknown'}`,
			};
			continue;
		}
		const structured = msg.result?.structuredContent || null;
		const ok = !!structured && structured.ok !== false;
		const conform = ok && schemaOk(tool, structured);
		if (ok) toolsOk++;
		if (conform) schemaOkCount++;

		const usage = readUsage(structured);
		promptTokens += usage.prompt;
		completionTokens += usage.completion;
		totalTokens += usage.total;

		const entry = { ok, schema_ok: conform };
		if (usage.total) entry.tokens = usage.total;
		if (tool === 'ibm_granite_embed' && structured) {
			embedDimensions = Number(structured.dimensions) || 0;
			embedInputs = Number(structured.inputCount) || 0;
			entry.dimensions = embedDimensions;
		}
		if (tool === 'ibm_granite_forecast' && structured) {
			forecastSteps = Number(structured.forecastSteps) || 0;
			entry.forecast_steps = forecastSteps;
		}
		if (!conform && ok) entry.error = 'schema_mismatch';
		perTool[tool] = entry;
	}

	const toolsTotal = GRANITE_HEALTH_TOOLS.length;
	return {
		server: GRANITE_SERVER,
		tools_total: toolsTotal,
		tools_ok: toolsOk,
		tools_failed: toolsTotal - toolsOk,
		schema_ok_count: schemaOkCount,
		watsonx_responding: toolsOk > 0,
		all_healthy: toolsOk === toolsTotal && schemaOkCount === toolsTotal,
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: totalTokens,
		embed_dimensions: embedDimensions,
		embed_inputs: embedInputs,
		forecast_steps: forecastSteps,
		per_tool: perTool,
	};
}

let schemaReady = false;

export async function ensureGraniteHealthSchema(client = sql) {
	if (schemaReady) return;
	try {
		await client`
			CREATE TABLE IF NOT EXISTS granite_inference_health (
				id                 bigserial PRIMARY KEY,
				checked_at         timestamptz NOT NULL DEFAULT now(),
				run_id             uuid,
				server             text NOT NULL DEFAULT 'ibm-x402-mcp',
				tools_total        int  NOT NULL,
				tools_ok           int  NOT NULL,
				tools_failed       int  NOT NULL,
				schema_ok_count    int  NOT NULL DEFAULT 0,
				watsonx_responding boolean NOT NULL DEFAULT false,
				all_healthy        boolean NOT NULL DEFAULT false,
				prompt_tokens      int  NOT NULL DEFAULT 0,
				completion_tokens  int  NOT NULL DEFAULT 0,
				total_tokens       int  NOT NULL DEFAULT 0,
				embed_dimensions   int  NOT NULL DEFAULT 0,
				embed_inputs       int  NOT NULL DEFAULT 0,
				forecast_steps     int  NOT NULL DEFAULT 0,
				latency_ms         int,
				per_tool           jsonb
			)
		`;
		await client`CREATE INDEX IF NOT EXISTS granite_inference_health_checked_at_idx ON granite_inference_health (checked_at DESC)`;
		schemaReady = true;
	} catch (err) {
		// Non-fatal: a migration system or a concurrent run may own the table.
		if (!/already exists/i.test(err?.message || '')) {
			log.warn('granite_health_schema_failed', { message: err?.message });
		}
		schemaReady = true;
	}
}

/**
 * Persist one health-check verdict to granite_inference_health.
 * Wired as the registry entry's storeValue — the loop calls it after a
 * successful paid call. Receives the loop's storeValue ctx; never throws
 * (the loop also wraps it, but we degrade cleanly regardless).
 *
 * @param {object} ctx loop storeValue ctx
 * @param {Function} ctx.sql        db tag (defaults to the shared client)
 * @param {object|Array} ctx.responseBody  batched JSON-RPC response
 * @param {object} [ctx.signalData] summary from extractSignal (reused if present)
 * @param {string} [ctx.runId]      loop run id (FK into x402_autonomous_log)
 * @param {number} [ctx.durationMs] paid round-trip latency
 * @returns {Promise<object|null>} the stored summary, or null if nothing stored
 */
export async function storeGraniteHealth(ctx = {}) {
	const client = ctx.sql || sql;
	const summary = ctx.signalData || summarizeGraniteHealth(ctx.responseBody);
	if (!summary || !summary.tools_total) return null;

	await ensureGraniteHealthSchema(client);
	await client`
		INSERT INTO granite_inference_health
			(run_id, server, tools_total, tools_ok, tools_failed, schema_ok_count,
			 watsonx_responding, all_healthy, prompt_tokens, completion_tokens,
			 total_tokens, embed_dimensions, embed_inputs, forecast_steps,
			 latency_ms, per_tool, checked_at)
		VALUES
			(${ctx.runId || null}, ${summary.server}, ${summary.tools_total},
			 ${summary.tools_ok}, ${summary.tools_failed}, ${summary.schema_ok_count},
			 ${summary.watsonx_responding}, ${summary.all_healthy},
			 ${summary.prompt_tokens}, ${summary.completion_tokens}, ${summary.total_tokens},
			 ${summary.embed_dimensions}, ${summary.embed_inputs}, ${summary.forecast_steps},
			 ${Number(ctx.durationMs) || null}, ${JSON.stringify(summary.per_tool || {})}, now())
	`;

	if (!summary.all_healthy) {
		log.warn('granite_health_degraded', {
			run_id: ctx.runId,
			tools_ok: summary.tools_ok,
			tools_failed: summary.tools_failed,
			schema_ok: summary.schema_ok_count,
			watsonx_responding: summary.watsonx_responding,
		});
	}
	return summary;
}

/**
 * Downstream read: latest health snapshot + recent token-throughput trend.
 * Consumed by GET /api/x402/granite-health.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowHours=24] rolling window for the throughput rollup
 * @returns {Promise<object>}
 */
export async function readGraniteHealth({ windowHours = 24 } = {}) {
	await ensureGraniteHealthSchema();
	const latestRows = await sql`
		SELECT checked_at, run_id, server, tools_total, tools_ok, tools_failed,
		       schema_ok_count, watsonx_responding, all_healthy,
		       prompt_tokens, completion_tokens, total_tokens,
		       embed_dimensions, embed_inputs, forecast_steps, latency_ms, per_tool
		FROM granite_inference_health
		ORDER BY checked_at DESC
		LIMIT 1
	`;
	const latest = latestRows[0] || null;

	const agg = await sql`
		SELECT count(*)::int AS checks,
		       coalesce(sum(total_tokens), 0)::bigint AS tokens,
		       coalesce(avg(latency_ms), 0)::int AS avg_latency_ms,
		       coalesce(sum((all_healthy)::int), 0)::int AS healthy_checks
		FROM granite_inference_health
		WHERE checked_at > now() - (${windowHours} || ' hours')::interval
	`;
	const a = agg[0] || {};
	const checks = Number(a.checks) || 0;

	return {
		ok: true,
		server: GRANITE_SERVER,
		healthy: latest ? latest.all_healthy : true,
		watsonx_responding: latest ? latest.watsonx_responding : null,
		window_hours: windowHours,
		latest: latest
			? {
				checked_at: latest.checked_at,
				run_id: latest.run_id,
				tools_total: latest.tools_total,
				tools_ok: latest.tools_ok,
				tools_failed: latest.tools_failed,
				schema_ok_count: latest.schema_ok_count,
				all_healthy: latest.all_healthy,
				total_tokens: latest.total_tokens,
				embed_dimensions: latest.embed_dimensions,
				forecast_steps: latest.forecast_steps,
				latency_ms: latest.latency_ms,
				per_tool: latest.per_tool,
			}
			: null,
		window: {
			checks,
			healthy_checks: Number(a.healthy_checks) || 0,
			uptime_pct: checks ? Math.round((Number(a.healthy_checks) / checks) * 1000) / 10 : null,
			total_tokens: Number(a.tokens) || 0,
			avg_latency_ms: Number(a.avg_latency_ms) || 0,
		},
	};
}

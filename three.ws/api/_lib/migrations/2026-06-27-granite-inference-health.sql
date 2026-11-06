-- Migration: IBM Granite inference health check (x402 autonomous loop, USE-007).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-06-27-granite-inference-health.sql
-- Idempotent.
--
-- The autonomous x402 spend loop (api/cron/x402-autonomous-loop.js) pays ONE
-- real x402 batch call to /api/ibm-mcp every 6 hours, invoking all five paid IBM
-- Granite tools (chat, code, embed, analyze, forecast) with tiny canary
-- arguments. api/_lib/x402/granite-health.js summarises the batch response —
-- verifying each tool answered with its expected schema and tallying token
-- throughput — and writes one verdict row here. The paid round-trip itself is
-- recorded to x402_autonomous_log (joined on run_id).
--
-- Downstream consumer: GET /api/x402/granite-health reads the latest snapshot
-- plus a rolling token-throughput / uptime rollup for the watsonx backend SLA
-- dashboard feed.

CREATE TABLE IF NOT EXISTS granite_inference_health (
	id                 bigserial PRIMARY KEY,
	checked_at         timestamptz NOT NULL DEFAULT now(),
	run_id             uuid,                    -- FK (logical) into x402_autonomous_log.run_id
	server             text NOT NULL DEFAULT 'ibm-x402-mcp',
	tools_total        int  NOT NULL,           -- tools exercised this check (5)
	tools_ok           int  NOT NULL,           -- tools that answered without a JSON-RPC error
	tools_failed       int  NOT NULL,
	schema_ok_count    int  NOT NULL DEFAULT 0, -- tools whose response matched the expected schema
	watsonx_responding boolean NOT NULL DEFAULT false,
	all_healthy        boolean NOT NULL DEFAULT false,
	prompt_tokens      int  NOT NULL DEFAULT 0,
	completion_tokens  int  NOT NULL DEFAULT 0,
	total_tokens       int  NOT NULL DEFAULT 0, -- token throughput across the batch
	embed_dimensions   int  NOT NULL DEFAULT 0,
	embed_inputs       int  NOT NULL DEFAULT 0,
	forecast_steps     int  NOT NULL DEFAULT 0,
	latency_ms         int,                     -- paid round-trip latency for the batch
	per_tool           jsonb                    -- { tool: { ok, schema_ok, tokens, error? } }
);

CREATE INDEX IF NOT EXISTS granite_inference_health_checked_at_idx
	ON granite_inference_health (checked_at DESC);

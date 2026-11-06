-- Migration: Builder Code Attribution Tracker (x402 autonomous loop, Finance).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-06-27-builder-code-attribution.sql
-- Idempotent.
--
-- The autonomous x402 spend loop (api/cron/x402-autonomous-loop.js) runs the
-- Builder Code Attribution Tracker (api/_lib/x402/pipelines/builder-code-attribution.js)
-- every 6 hours. It sweeps a representative set of priced /api/x402/* endpoints,
-- verifying each declares the ERC-8021 builder-code extension
-- (extensions["builder-code"].info.a = three_d_agent, set by X402_BUILDER_CODE_APP)
-- on its live 402 challenge — the precondition for Coinbase builder rewards to
-- credit that endpoint's settled volume. It then pays ONE real $0.001 USDC
-- payment to the cheapest declaring endpoint (dance-tip) with the builder-code
-- echo attached to the X-PAYMENT envelope, reads the X-PAYMENT-RESPONSE
-- settlement, and confirms an attributed payment settles end-to-end. The paid
-- round-trip itself is recorded to x402_autonomous_log (joined on run_id).
--
-- One row per endpoint (upserted, keyed by endpoint). `gap = true` marks a
-- priced endpoint missing/mismatched on its three_d_agent declaration — the
-- attribution gap the tracker alerts on.
--
-- Downstream consumer: api/ops/health.js -> loadBuilderAttribution() folds an
-- open attribution gap (or a failed attributed settlement) into the platform
-- health verdict so on-call sees lost-rewards risk before a billing cycle closes.

CREATE TABLE IF NOT EXISTS builder_code_attribution (
	endpoint             text PRIMARY KEY,
	method               text,
	challenged           boolean NOT NULL DEFAULT false, -- returned a real 402 challenge
	attributed           boolean NOT NULL DEFAULT false, -- declared builder-code on the challenge
	declared_code        text,                           -- the `a` app code advertised
	expected_code        text,                           -- X402_BUILDER_CODE_APP in force
	matches              boolean NOT NULL DEFAULT false,  -- declared_code === expected_code
	price_atomic         bigint,                          -- challenge amount (USDC atomics)
	gap                  boolean NOT NULL DEFAULT false,  -- 402 endpoint with missing/mismatched attribution
	settled              boolean NOT NULL DEFAULT false,  -- this endpoint carried the live settlement proof
	echo_accepted        boolean NOT NULL DEFAULT false,  -- attributed payment settled (server enforces echo)
	response_attributed  boolean NOT NULL DEFAULT false,  -- X-PAYMENT-RESPONSE echoed a builder-code block
	tx_signature         text,                            -- on-chain settlement tx (Coinbase reward indexer reads this)
	payer                text,
	error                text,
	run_id               uuid,                            -- FK (logical) into x402_autonomous_log.run_id
	checked_at           timestamptz DEFAULT now()
);

-- Partial index: ops/health only ever scans for currently-open gaps.
CREATE INDEX IF NOT EXISTS builder_code_attribution_gap_idx
	ON builder_code_attribution (gap) WHERE gap = true;

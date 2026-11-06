-- 2026-07-03-x402-ring-leak-scan.sql
--
-- On-chain leak scanner state (api/cron/x402-ring-leak-scan.js).
--
-- The scanner is the ACTIVE, on-chain half of the leak-proofing invariant: "no
-- SOL or USDC ever leaves the controlled-wallet set." Every 10 min it walks each
-- ring wallet's recent signatures, classifies every debit as internal /
-- network_fee / LEAK, and alarms on any LEAK. These two tables are its only
-- durable state — the scanner itself never moves funds.
--
--   x402_ring_scan_cursor    — per-wallet resume point. getSignaturesForAddress
--                              walks newest→oldest; we pass until=last_signature
--                              so each run only classifies signatures newer than
--                              the last scanned one. Bounds RPC (≤100 sigs/wallet)
--                              and makes the scan idempotent — a tx is classified
--                              exactly once, which is what lets the fee rollup
--                              below accumulate without double counting.
--
--   x402_ring_fee_observed   — per-UTC-day sum of network fees ACTUALLY paid by
--                              ring wallets on-chain, accumulated as the scanner
--                              sees each new fee-paying tx. Cross-checked against
--                              task 05's x402_fee_audit rollup: a >20% mismatch
--                              means fees are being paid outside the ring's own
--                              accounting → WARN.

CREATE TABLE IF NOT EXISTS x402_ring_scan_cursor (
	wallet          text PRIMARY KEY,           -- ring wallet pubkey being scanned
	last_signature  text,                       -- newest signature classified last run (until= anchor)
	last_slot       bigint,                     -- slot of last_signature (diagnostics only)
	scanned_total   bigint NOT NULL DEFAULT 0,  -- cumulative signatures classified
	leaks_total     bigint NOT NULL DEFAULT 0,  -- cumulative LEAK classifications
	last_run_id     uuid,
	updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS x402_ring_fee_observed (
	day              date PRIMARY KEY,          -- UTC day of the fee-paying tx
	fee_lamports     bigint NOT NULL DEFAULT 0, -- summed network fees paid by ring wallets that day
	tx_count         bigint NOT NULL DEFAULT 0, -- fee-paying tx count that day
	updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS x402_ring_fee_observed_day ON x402_ring_fee_observed (day DESC);

-- Replay guard for x402 checkout analytics.
--
-- api/x402-checkout-record records a settled paid call against a SKU. Without a
-- uniqueness constraint the same tx_signature could be recorded unlimited times,
-- letting anyone replay one real payment to inflate a merchant's revenue and
-- conversion stats (which sum amount_atomics over response_status < 400).
--
-- Dedupe any existing duplicate rows (keep the earliest per sku+tx), then enforce
-- one record per (sku_id, tx_signature). Rows with a null tx_signature (failed or
-- pre-settlement attempts) are intentionally exempt from the constraint.

DELETE FROM x402_checkout_calls a
USING x402_checkout_calls b
WHERE a.tx_signature IS NOT NULL
  AND a.tx_signature = b.tx_signature
  AND a.sku_id = b.sku_id
  AND (a.paid_at > b.paid_at OR (a.paid_at = b.paid_at AND a.ctid > b.ctid));

CREATE UNIQUE INDEX IF NOT EXISTS x402_checkout_calls_sku_tx_uniq
  ON x402_checkout_calls (sku_id, tx_signature)
  WHERE tx_signature IS NOT NULL;

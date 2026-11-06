-- One on-chain tx may confirm at most one agent-payment invoice.
--
-- Before this, accept-payment-confirm only checked that the agent mint appeared
-- in the tx account keys — it never verified the amount, the recipient vault, or
-- that the signature was previously unused. A single cheap tx could confirm any
-- number of invoices. This index plus the rewritten verifier (vault credit +
-- payer + amount) closes that.
--
-- Idempotent.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS pump_agent_payments_tx_signature_unique
    ON pump_agent_payments (tx_signature)
    WHERE tx_signature IS NOT NULL;

COMMIT;

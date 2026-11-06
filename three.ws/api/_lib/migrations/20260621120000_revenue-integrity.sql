-- Revenue-ledger integrity: a single on-chain payment must credit exactly once,
-- and money columns must never go negative.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260621120000_revenue-integrity.sql
-- Idempotent.
--
-- NOTE ON LOCKING: this builds a UNIQUE index on agent_revenue_events with a
-- brief write lock. The table is small at time of writing, so this is sub-second.
-- If it has grown large by apply time, build the index out-of-band with
-- CREATE UNIQUE INDEX CONCURRENTLY (which cannot run inside this transaction)
-- and skip that one statement here.

begin;

-- 1. Collapse any phantom duplicate credits created before the application-layer
-- consume-claim gate landed. Keep the earliest row per intent_id (the legitimate
-- credit); the rest are double-counts that inflated withdrawable balance. Only
-- touches intent_ids that actually have >1 row.
DELETE FROM agent_revenue_events a
USING (
    SELECT intent_id, MIN(created_at) AS keep_created_at, MIN(id::text) AS keep_id
    FROM agent_revenue_events
    WHERE intent_id IS NOT NULL
    GROUP BY intent_id
    HAVING COUNT(*) > 1
) dup
WHERE a.intent_id = dup.intent_id
  AND NOT (a.created_at = dup.keep_created_at AND a.id::text = dup.keep_id);

-- 2. One credit per intent_id. NULL intent_ids are allowed (legacy/direct rows
-- predating dedupe keys) and excluded from the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS agent_revenue_events_intent_uniq
    ON agent_revenue_events (intent_id)
    WHERE intent_id IS NOT NULL;

-- 3. Money is never negative. Added valid (these invariants hold for all
-- correctly-recorded rows); the sum-reconciliation check is NOT VALID so it
-- guards new writes without retroactively failing on any historical row whose
-- legs were recorded under older split logic.
DO $$ BEGIN
    ALTER TABLE agent_revenue_events
        ADD CONSTRAINT agent_revenue_events_nonneg
        CHECK (gross_amount >= 0 AND fee_amount >= 0
               AND net_amount >= 0 AND platform_fee_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE agent_revenue_events
        ADD CONSTRAINT agent_revenue_events_split
        CHECK (gross_amount = fee_amount + net_amount + platform_fee_amount) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE agent_withdrawals
        ADD CONSTRAINT agent_withdrawals_amount_pos
        CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

commit;

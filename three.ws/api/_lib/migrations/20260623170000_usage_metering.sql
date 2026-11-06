-- Migration: usage metering — the queryable billing ledger.
-- ============================================================================
-- Every priced action that SUCCEEDS records one usage_event with the money it
-- moved, back-linked to the settlement that paid for it. This is the single
-- ledger that produces receipts, the periodic invoice statement, and the
-- reconciliation pass (usage with no settlement, or a settlement with no usage).
--
-- These columns are ADDITIVE on the existing usage_events table (see
-- migrations/20260605120000_usage_events.sql) and fully idempotent — safe to
-- run repeatedly and against a DB that already has them. Metered rows carry
-- kind='metered'; pre-existing quota/analytics/llm rows are untouched.
--
--   meter_action        — the catalog action id charged (e.g. 'forge.high').
--   units               — quantity billed (default 1).
--   price_usdc_atomics  — gross price in USDC atomics (6 decimals) at charge time,
--                         i.e. the holder-discounted price actually quoted.
--   fee_usdc_atomics    — the platform's cut in USDC atomics. For consumption /
--                         scarcity actions (no seller) the platform keeps the whole
--                         price, so fee == price; for marketplace sales fee is the
--                         platform-fee-bps portion and (price - fee) is the seller's.
--   discount_bps        — the holder-tier discount applied to reach price (0–10000),
--                         recorded so a receipt can show "you saved X% by holding".
--   settlement_ref      — the settlement this usage is paid by: a token_payments.id
--                         (uuid as text), an on-chain tx signature, or an AWS usage
--                         allocation id. The reconciliation pass joins on this.
--   settlement_kind     — which rail settled it: 'three' | 'x402' | 'aws' | 'card'.
--   idempotency_key     — UNIQUE per charge so a retried settlement meters EXACTLY
--                         once (no double-billing). Defaults to settlement_ref.
--
-- Money is stored in atomics (bigint), never floats, so statement sums never drift.

alter table usage_events add column if not exists meter_action       text;
alter table usage_events add column if not exists units              int;
alter table usage_events add column if not exists price_usdc_atomics bigint;
alter table usage_events add column if not exists fee_usdc_atomics   bigint;
alter table usage_events add column if not exists discount_bps       int;
alter table usage_events add column if not exists settlement_ref     text;
alter table usage_events add column if not exists settlement_kind    text;
alter table usage_events add column if not exists idempotency_key    text;

-- Idempotency: a retried charge for the same settlement must meter once. A
-- partial UNIQUE index (only metered rows carry a key) lets the INSERT use
-- ON CONFLICT (idempotency_key) DO NOTHING as the no-double-spend guarantee
-- without constraining the millions of non-metered analytics/quota rows.
create unique index if not exists usage_events_idem
    on usage_events(idempotency_key)
    where idempotency_key is not null;

-- Reconciliation scans metered rows by settlement_ref to match each against a
-- real token_payments row (or AWS metering ack).
create index if not exists usage_events_settlement
    on usage_events(settlement_ref)
    where settlement_ref is not null;

-- Invoice rollups scan a user's metered rows over a time window.
create index if not exists usage_events_metered_user_time
    on usage_events(user_id, created_at desc)
    where kind = 'metered';

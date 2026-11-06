-- Migration: skill_payment_earnings + payouts — creator revenue ledger.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260618120000_skill_payment_earnings.sql
-- Idempotent.
--
-- One earnings row is written per settled skill payment, attributing the revenue
-- to the agent's creator and splitting the gross charge into the platform fee and
-- the creator's net share. `payout_id` stays NULL until the earnings are swept
-- into a payout batch, at which point the creator is paid their accumulated net.
--
-- This is the accounting source of truth behind the creator revenue dashboard and
-- the payout pipeline. Every money column is stored in the currency's smallest
-- unit (lamports for SOL, atomics for SPL tokens) as BIGINT, never as a float.
--
-- FK mapping (this codebase vs. the generic spec):
--   payment_id → skill_purchases(id)   -- canonical settled skill-payment ledger
--   agent_id   → agent_identities(id)  -- canonical agent table
--   creator_id → users(id)             -- the agent's creator is agent_identities.user_id

begin;

-- ── payouts — a batch withdrawal of accumulated creator earnings ──────────────
-- Created before skill_payment_earnings because that table FKs into it.
create table if not exists payouts (
    id                  uuid primary key default gen_random_uuid(),
    creator_id          uuid not null references users(id),
    amount              bigint not null check (amount > 0),
    currency_mint       text not null,
    status              text not null default 'pending'
                          check (status in ('pending', 'processing', 'completed', 'failed')),
    destination_address text not null,
    tx_signature        text,
    failure_reason      text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    completed_at        timestamptz
);

-- A settled payout has exactly one on-chain signature. Partial-unique so many
-- pending/failed payouts (null signature) coexist while a signature never repeats.
create unique index if not exists payouts_tx_signature_unique
    on payouts (tx_signature) where tx_signature is not null;

-- Creator dashboard: a creator's payout history, newest first.
create index if not exists idx_payouts_creator_status
    on payouts (creator_id, status, created_at desc);

-- Payout worker: pick up the open (pending/processing) batches to settle.
create index if not exists idx_payouts_status
    on payouts (status, created_at desc)
    where status in ('pending', 'processing');

do $$ begin
    create trigger payouts_set_updated_at before update on payouts
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- ── skill_payment_earnings — per-sale creator revenue ledger ──────────────────
create table if not exists skill_payment_earnings (
    id                  uuid primary key default gen_random_uuid(),
    -- Exactly one earnings row per payment; cascade so a deleted payment can't
    -- leave an orphaned earnings record behind.
    payment_id          uuid not null unique
                          references skill_purchases(id) on delete cascade,
    agent_id            uuid not null references agent_identities(id) on delete cascade,
    creator_id          uuid not null references users(id),

    gross_amount        bigint  not null check (gross_amount >= 0),
    platform_fee_bps    integer not null check (platform_fee_bps between 0 and 10000),
    platform_fee_amount bigint  not null check (platform_fee_amount >= 0),
    net_amount          bigint  not null check (net_amount >= 0),

    currency_mint       text not null,

    -- NULL until the earnings are swept into a payout batch. ON DELETE SET NULL so
    -- voiding a payout returns its earnings to the unpaid pool rather than deleting
    -- the financial record.
    payout_id           uuid references payouts(id) on delete set null,

    created_at          timestamptz not null default now(),

    -- The split must reconcile exactly: gross = platform fee + creator net.
    constraint skill_payment_earnings_amounts_balance
        check (gross_amount = platform_fee_amount + net_amount)
);

-- Creator dashboard: list a creator's earnings newest-first.
create index if not exists idx_skill_earnings_creator_id
    on skill_payment_earnings (creator_id, created_at desc);

-- Find every earnings row included in a given payout batch.
create index if not exists idx_skill_earnings_payout_id
    on skill_payment_earnings (payout_id) where payout_id is not null;

-- Hot path for payouts: a creator's unpaid (available-to-withdraw) balance.
create index if not exists idx_skill_earnings_unpaid
    on skill_payment_earnings (creator_id, created_at)
    where payout_id is null;

-- Per-agent revenue analytics.
create index if not exists idx_skill_earnings_agent_id
    on skill_payment_earnings (agent_id, created_at desc);

commit;

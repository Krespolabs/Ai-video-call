-- Migration: per-coin autopilot policy for the autonomous coin agent.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260605140000_pump_autopilot.sql
-- Idempotent.
--
-- The run-buyback and run-distribute-payments crons previously fired for every
-- pump_agent_mints row unconditionally. This table gives each coin's owner an
-- explicit policy: a master enable switch, per-action toggles, and minimum vault
-- thresholds (in currency atomics) so the agent only acts when it is worth the
-- network fee. A missing row preserves legacy behaviour (treated as enabled with
-- zero thresholds), so existing coins are unaffected until an owner opts in.

begin;

create table if not exists pump_autopilot (
    mint_id                 uuid primary key references pump_agent_mints(id) on delete cascade,
    enabled                 boolean not null default true,
    buyback_enabled         boolean not null default true,
    buyback_min_atomics     numeric(40, 0) not null default 0,   -- min buyback-vault balance to fire
    buyback_full_swap       boolean not null default false,      -- true = swap+burn, false = burn-only
    distribute_enabled      boolean not null default true,
    distribute_min_atomics  numeric(40, 0) not null default 0,   -- min payment-vault balance to distribute
    narrate                 boolean not null default true,       -- emit avatar narration events
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

commit;

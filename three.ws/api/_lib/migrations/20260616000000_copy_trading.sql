-- Migration: non-custodial copy trading.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260616000000_copy_trading.sql
-- Idempotent.
--
-- A copier follows a leader (an agent with a sniper track record) and, when the
-- leader opens/closes a position, we generate a sized, safety-checked copy INTENT
-- the copier acts on from their own wallet. We never take custody and never sign
-- for them in this phase — the copier executes (Co-Pilot model). The perf-fee /
-- high-water-mark columns are seeded here but only settled in Phase 3.

begin;

create table if not exists copy_subscriptions (
    id                  uuid primary key default gen_random_uuid(),
    copier_user_id      uuid not null references users(id) on delete cascade,
    copier_wallet       text not null,                                  -- wallet the copier trades from
    leader_agent_id     uuid not null references agent_identities(id) on delete cascade,
    leader_wallet       text,                                           -- denormalized; matches sniper positions
    network             text not null default 'mainnet' check (network in ('mainnet','devnet')),
    status              text not null default 'active' check (status in ('active','paused','stopped')),

    -- sizing: how the copier's order is derived from the leader's entry
    sizing_rule         text not null default 'fixed' check (sizing_rule in ('fixed','multiplier','pct_balance')),
    fixed_sol           numeric not null default 0,                     -- sizing_rule=fixed
    multiplier          numeric not null default 0.1,                   -- sizing_rule=multiplier (× leader entry)
    pct_balance         numeric not null default 0,                     -- sizing_rule=pct_balance (% of copier SOL)

    -- guards
    per_trade_cap_sol   numeric not null default 0.5,                   -- hard ceiling on any one copy
    min_order_sol       numeric not null default 0.02,                  -- skip dust copies below this
    daily_budget_sol    numeric not null default 1,                     -- max copy SOL fanned out per UTC day
    max_open_copies     int     not null default 5,                     -- cap concurrent pending intents
    mcap_floor_usd      numeric,                                        -- null = ignore
    mcap_ceiling_usd    numeric,                                        -- null = ignore
    copy_sells          boolean not null default true,                  -- mirror exits, not just entries
    require_safety_pass boolean not null default false,                 -- skip when coin safety can't be confirmed

    -- perf fee (Phase 3)
    perf_fee_bps        int     not null default 1000,                  -- leader's cut of copier profit (10%)
    high_water_mark_sol numeric not null default 0,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    unique (copier_user_id, leader_agent_id, network),
    constraint copy_cap_positive check (per_trade_cap_sol > 0),
    constraint copy_perf_fee_range check (perf_fee_bps >= 0 and perf_fee_bps <= 3000)
);

create index if not exists copy_subscriptions_copier
    on copy_subscriptions (copier_user_id, status);
create index if not exists copy_subscriptions_leader_active
    on copy_subscriptions (leader_agent_id, network)
    where status = 'active';

create table if not exists copy_executions (
    id                  uuid primary key default gen_random_uuid(),
    subscription_id     uuid not null references copy_subscriptions(id) on delete cascade,
    copier_user_id      uuid not null,
    leader_agent_id     uuid not null,
    leader_position_id  uuid not null,                                  -- agent_sniper_positions.id that triggered it
    network             text not null default 'mainnet' check (network in ('mainnet','devnet')),
    mint                text not null,
    symbol              text,
    name                text,
    direction           text not null default 'buy' check (direction in ('buy','sell')),

    planned_sol         numeric,                                        -- sized order (null when skipped)
    leader_entry_sol    numeric,
    status              text not null default 'pending'
                          check (status in ('pending','acted','dismissed','skipped','expired')),
    skip_reason         text,
    safety              jsonb,                                          -- coin-context snapshot used for the decision
    quote               jsonb,                                          -- live quote snapshot at fanout time
    leader_buy_sig      text,
    tx_signature        text,                                           -- set if the copier records their fill

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    expires_at          timestamptz not null default (now() + interval '30 minutes'),
    -- idempotency: one copy intent per leader position per direction per subscription
    unique (subscription_id, leader_position_id, direction)
);

create index if not exists copy_executions_copier
    on copy_executions (copier_user_id, status, created_at desc);
create index if not exists copy_executions_pending
    on copy_executions (status, expires_at)
    where status = 'pending';
create index if not exists copy_executions_sub
    on copy_executions (subscription_id, created_at desc);

commit;

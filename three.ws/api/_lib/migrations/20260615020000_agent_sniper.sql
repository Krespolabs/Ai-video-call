-- Migration: autonomous pump.fun sniper — per-agent strategy + position ledger.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260615020000_agent_sniper.sql
-- Idempotent.
--
-- The agent-sniper worker (workers/agent-sniper) watches the live PumpPortal
-- feed, scores new mints against a per-agent strategy, and trades from the
-- agent's OWN encrypted Solana wallet. These two tables are the canonical store:
--
--   agent_sniper_strategies  — the owner-armed policy (caps, filters, exits, kill).
--   agent_sniper_positions   — every open/closed position. This is the sniper's
--     own trade ledger; it is NOT pump_agent_trades, whose mint_id is NOT NULL
--     and FKs to pump_agent_mints — a row sniped mints (launched by strangers)
--     will never have.
--
-- All SOL amounts are stored as lamports (numeric(40,0)) to avoid float drift.

begin;

create table if not exists agent_sniper_strategies (
    id                        uuid primary key default gen_random_uuid(),
    agent_id                  uuid not null references agent_identities(id) on delete cascade,
    user_id                   uuid not null references users(id) on delete cascade,
    enabled                   boolean not null default false,
    kill_switch               boolean not null default false,        -- per-agent emergency stop
    network                   text not null default 'mainnet' check (network in ('mainnet','devnet')),

    -- budget / sizing (lamports)
    daily_budget_lamports     numeric(40, 0) not null default 0,      -- 0 = nothing armed
    per_trade_lamports        numeric(40, 0) not null default 0,      -- buy size per snipe
    max_concurrent_positions  int not null default 1,
    slippage_bps              int not null default 500,
    max_price_impact_pct      numeric not null default 10,            -- circuit breaker on entry quote

    -- entry filters (null = ignore)
    min_market_cap_usd        numeric,
    max_market_cap_usd        numeric,
    min_creator_graduated     int,                                    -- creator must have >= N graduated coins
    max_creator_launches      int,                                    -- reject serial ruggers (too many launches)
    require_socials           boolean not null default false,
    require_sol_quote         boolean not null default true,          -- reject USDC/OTHER-paired coins

    -- exits
    take_profit_pct           numeric,                                -- null = no TP
    stop_loss_pct             numeric not null default 30,            -- MANDATORY, enforced not-null
    trailing_stop_pct         numeric,                                -- null = no trailing stop
    max_hold_seconds          int not null default 1800,              -- timeout exit

    created_at                timestamptz not null default now(),
    updated_at                timestamptz not null default now(),
    unique (agent_id, network),
    constraint agent_sniper_stop_loss_positive check (stop_loss_pct > 0)
);

create index if not exists agent_sniper_strategies_active
    on agent_sniper_strategies (enabled, kill_switch)
    where enabled = true and kill_switch = false;
create index if not exists agent_sniper_strategies_user
    on agent_sniper_strategies (user_id);

create table if not exists agent_sniper_positions (
    id                              uuid primary key default gen_random_uuid(),
    strategy_id                     uuid not null references agent_sniper_strategies(id) on delete cascade,
    agent_id                        uuid not null,
    user_id                         uuid not null,
    wallet                          text not null,                    -- agent solana address
    network                         text not null default 'mainnet' check (network in ('mainnet','devnet')),
    mint                            text not null,
    symbol                          text,
    name                            text,

    status                          text not null default 'opening'
                                      check (status in ('opening','open','closing','closed','failed')),
    exit_reason                     text
                                      check (exit_reason in
                                        ('take_profit','stop_loss','trailing_stop','timeout',
                                         'manual','kill_switch','graduated','error')),

    -- entry
    buy_sig                         text,
    entry_quote_lamports            numeric(40, 0),                   -- SOL spent
    base_amount                     numeric(40, 0),                   -- token base units bought
    entry_price_lamports_per_token  numeric,
    entry_price_impact_pct          numeric,

    -- live tracking
    peak_value_lamports             numeric(40, 0),                   -- high-water mark for trailing stop
    last_value_lamports             numeric(40, 0),                   -- last quoteForSell expectedQuoteOut
    last_quoted_at                  timestamptz,

    -- exit
    sell_sig                        text,
    exit_quote_lamports             numeric(40, 0),                   -- SOL received
    realized_pnl_lamports           numeric(40, 0),                   -- exit - entry (signed)
    realized_pnl_pct                numeric,

    error                           text,
    opened_at                       timestamptz not null default now(),
    closed_at                       timestamptz,
    -- idempotency: at most one position per mint per agent per network.
    unique (agent_id, mint, network)
);

create index if not exists agent_sniper_positions_open
    on agent_sniper_positions (network, status)
    where status in ('opening','open','closing');
create index if not exists agent_sniper_positions_agent
    on agent_sniper_positions (agent_id, network, opened_at desc);
-- Powers the SSE diff cursor: rows touched since a timestamp, newest first.
create index if not exists agent_sniper_positions_changed
    on agent_sniper_positions (greatest(opened_at, coalesce(closed_at, opened_at), coalesce(last_quoted_at, opened_at)) desc);

commit;

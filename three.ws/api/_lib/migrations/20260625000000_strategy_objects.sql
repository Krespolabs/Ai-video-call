-- Strategy Objects — an ownable, equippable, shareable, forkable trade strategy.
--
-- A Strategy Object encodes a real, rule-based plan (entry conditions, sizing,
-- take-profit, stop-loss, max concurrent positions, cooldown) as a named, owned,
-- versioned thing. Equipping it on an agent activates a runtime binding; the
-- cron strategy runtime evaluates REAL pump.fun launches + REAL holdings and
-- executes trades through the same guarded task-05 execution + custody path that
-- backs the discretionary trade endpoint. Forking copies the RULES into another
-- owner's library with full lineage — never any wallet access.
--
-- Three tables:
--   agent_strategies          the ownable object (forkable, publishable, versioned)
--   agent_strategy_equips      a strategy bound to an agent (runtime state)
--   agent_strategy_positions   open/closed positions for TP/SL + real live perf
-- plus strategy_kill_switch    a per-owner global halt-all toggle.

-- ── the strategy object ───────────────────────────────────────────────────────
create table if not exists agent_strategies (
    id            uuid primary key default gen_random_uuid(),
    owner_id      uuid not null references users(id),
    name          text not null check (length(name) between 1 and 80),
    slug          text not null,
    description   text check (description is null or length(description) <= 2000),
    config        jsonb not null default '{}'::jsonb,
    version       int  not null default 1,
    published     boolean not null default false,
    published_at  timestamptz,
    fork_of       uuid references agent_strategies(id) on delete set null,
    forked_from   jsonb,
    forks_count   int  not null default 0,
    equips_count  int  not null default 0,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    deleted_at    timestamptz
);

create unique index if not exists idx_agent_strategies_owner_slug
    on agent_strategies (owner_id, slug) where deleted_at is null;
create index if not exists idx_agent_strategies_owner
    on agent_strategies (owner_id) where deleted_at is null;
create index if not exists idx_agent_strategies_published
    on agent_strategies (published_at desc) where published = true and deleted_at is null;
create index if not exists idx_agent_strategies_fork_of
    on agent_strategies (fork_of) where fork_of is not null;

-- ── equip: a strategy active on an agent ──────────────────────────────────────
create table if not exists agent_strategy_equips (
    id               uuid primary key default gen_random_uuid(),
    strategy_id      uuid not null references agent_strategies(id) on delete cascade,
    agent_id         uuid not null,
    owner_id         uuid not null references users(id),
    config_snapshot  jsonb not null default '{}'::jsonb,   -- the rules at equip time (version pin)
    strategy_version int  not null default 1,
    network          text not null default 'mainnet' check (network in ('mainnet','devnet')),
    active           boolean not null default true,
    last_eval_at     timestamptz,
    last_fired_at    timestamptz,
    fires_count      int  not null default 0,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    unique (agent_id, strategy_id)
);

create index if not exists idx_strategy_equips_active
    on agent_strategy_equips (network) where active = true;
create index if not exists idx_strategy_equips_agent on agent_strategy_equips (agent_id);
create index if not exists idx_strategy_equips_strategy on agent_strategy_equips (strategy_id);
create index if not exists idx_strategy_equips_owner on agent_strategy_equips (owner_id);

-- ── positions: real fills, the entry basis for exits + the live track record ──
create table if not exists agent_strategy_positions (
    id            uuid primary key default gen_random_uuid(),
    equip_id      uuid not null references agent_strategy_equips(id) on delete cascade,
    strategy_id   uuid not null references agent_strategies(id) on delete cascade,
    agent_id      uuid not null,
    owner_id      uuid not null,
    network       text not null default 'mainnet' check (network in ('mainnet','devnet')),
    mint          text not null,
    symbol        text,
    name          text,
    status        text not null default 'open'
                    check (status in ('open','closing','closed','failed')),
    exit_reason   text
                    check (exit_reason in
                      ('take_profit','stop_loss','trailing_stop','timeout','manual','kill_switch','error')),

    -- entry (real fill)
    entry_sig              text,
    entry_lamports         numeric(40,0),   -- SOL spent (lamports)
    base_amount            numeric(40,0),   -- token base units bought
    entry_price_impact_pct numeric,

    -- live tracking (re-quoted each sweep against real chain state)
    peak_value_lamports    numeric(40,0),   -- high-water mark for trailing stop
    last_value_lamports    numeric(40,0),   -- last quoteForSell value
    last_quoted_at         timestamptz,

    -- exit (real fill)
    exit_sig               text,
    exit_lamports          numeric(40,0),   -- SOL received
    realized_pnl_lamports  numeric(40,0),   -- exit - entry (signed)
    realized_pnl_pct       numeric,

    error         text,
    opened_at     timestamptz not null default now(),
    closed_at     timestamptz,
    unique (agent_id, mint, network)
);

create index if not exists idx_strategy_positions_open
    on agent_strategy_positions (network) where status in ('open','closing');
create index if not exists idx_strategy_positions_strategy on agent_strategy_positions (strategy_id);
create index if not exists idx_strategy_positions_equip on agent_strategy_positions (equip_id);
create index if not exists idx_strategy_positions_agent on agent_strategy_positions (agent_id);

-- ── per-owner global kill switch (halts ALL the owner's strategies at once) ────
create table if not exists strategy_kill_switch (
    owner_id   uuid primary key references users(id),
    engaged    boolean not null default false,
    engaged_at timestamptz,
    updated_at timestamptz not null default now()
);

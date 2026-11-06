-- Migration: autonomous coin launcher (Memetic Launcher).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260629060000_coin_launcher.sql
--        (or `npm run db:migrate`). Idempotent.
--
-- The autonomous launcher mints pump.fun coins on a hybrid cadence: real trend
-- signals fire first, a throttled meme/random generator fills to a target rate.
-- A master wallet (SOLANA_SIGNERS 'coin-launcher-master') tops up the next agent
-- in the rotation with the per-launch SOL, then that agent signs its OWN create
-- (api/pump/[action].js handleLaunchAgent) — so every coin carries a real agent
-- avatar as its on-chain identity. Each launch routes buyback_bps into $THREE
-- buyback-and-burn and lands in /launches as a runtime record.
--
-- Three tables:
--   launcher_config — one row per scope ('global' admin default, or per 'user').
--   launcher_queue  — the curated agent rotation (who can launch, in what order).
--   launcher_runs   — append-only audit of every attempt (cost, mint, status).
--
-- Ships SAFE: a fresh global row is disabled + dry_run, so no real SOL moves and
-- no coin mints until an operator explicitly arms it.

begin;

-- ── launcher_config ─────────────────────────────────────────────────────────
create table if not exists launcher_config (
    id                  uuid primary key default gen_random_uuid(),
    -- 'global' is the admin-set platform default (singleton). 'user' is a single
    -- user's own launcher policy, keyed by user_id.
    scope               text not null check (scope in ('global', 'user')),
    user_id             uuid references users(id) on delete cascade,

    -- Master switches. enabled=false ⇒ the launcher never fires for this scope.
    -- dry_run=true ⇒ the engine selects a source + agent and records the run but
    -- never moves SOL or submits a create (the safe default).
    enabled             boolean not null default false,
    dry_run             boolean not null default true,

    -- 'off' | 'trend' | 'meme' | 'random' | 'hybrid' (trend-priority + filler).
    mode                text not null default 'hybrid'
                        check (mode in ('off', 'trend', 'meme', 'random', 'hybrid')),
    -- Which trend providers feed 'trend'/'hybrid' mode, e.g.
    -- ["coin_intel","trending","knowyourmeme","googletrends","x"]. Empty ⇒ all configured providers.
    sources             jsonb not null default '["coin_intel","trending","knowyourmeme","googletrends","x"]'::jsonb,
    -- Restrict trend picks to these pump_coin_intel categories (meme/culture/...).
    -- Empty ⇒ no category filter.
    categories          jsonb not null default '[]'::jsonb,

    -- Cadence + rate. The worker aims for one launch per target_cadence_seconds
    -- but never exceeds max_per_hour (a hard hourly ceiling, independent of SOL).
    target_cadence_seconds  integer not null default 60 check (target_cadence_seconds >= 5),
    max_per_hour            integer not null default 30 check (max_per_hour >= 0),

    -- Economics, in SOL. per_launch_sol = deploy cost + dev_buy headroom moved to
    -- the agent. dev_buy_sol = the initial buy the agent makes on its own curve.
    per_launch_sol      numeric(20, 9) not null default 0.03 check (per_launch_sol >= 0),
    dev_buy_sol         numeric(20, 9) not null default 0    check (dev_buy_sol >= 0),
    daily_sol_cap       numeric(20, 9) not null default 1    check (daily_sol_cap >= 0),
    -- Share of trade fees routed to $THREE buyback-and-burn (0..10000 bps).
    buyback_bps         integer not null default 5000 check (buyback_bps between 0 and 10000),
    network             text not null default 'mainnet' check (network in ('mainnet', 'devnet')),

    -- Circuit breaker. Tripped automatically on repeated failure / low master
    -- balance / daily cap; cleared by an operator. Distinct from enabled so the
    -- breaker never silently flips the user's master switch.
    paused              boolean not null default false,
    pause_reason        text,

    updated_by          uuid references users(id) on delete set null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- One global row; one row per user.
create unique index if not exists launcher_config_global_uniq
    on launcher_config (scope) where scope = 'global';
create unique index if not exists launcher_config_user_uniq
    on launcher_config (user_id) where scope = 'user';

-- ── launcher_queue ──────────────────────────────────────────────────────────
-- The rotation. Each row makes one agent eligible to launch. The engine picks
-- the enabled agent with the oldest last_launched_at (nulls first), weighted by
-- `weight`, so launches fan out across avatars instead of hammering one wallet.
create table if not exists launcher_queue (
    agent_id        uuid primary key references agent_identities(id) on delete cascade,
    -- The scope that enrolled this agent. 'global' agents serve the platform
    -- launcher; 'user' agents serve their owner's launcher only.
    scope           text not null default 'user' check (scope in ('global', 'user')),
    user_id         uuid references users(id) on delete cascade,
    enabled         boolean not null default true,
    weight          integer not null default 1 check (weight >= 0),
    last_launched_at timestamptz,
    launch_count    integer not null default 0,
    created_at      timestamptz not null default now()
);
create index if not exists launcher_queue_pick_idx
    on launcher_queue (scope, enabled, last_launched_at nulls first);

-- ── launcher_runs ───────────────────────────────────────────────────────────
-- Append-only audit. Every engine tick that decides to launch writes one row,
-- transitioning through status as it funds + submits. Powers the live console
-- and the daily-spend ceiling (sum of sol_spent where created today).
create table if not exists launcher_runs (
    id              uuid primary key default gen_random_uuid(),
    scope           text not null default 'global' check (scope in ('global', 'user')),
    user_id         uuid references users(id) on delete set null,
    agent_id        uuid references agent_identities(id) on delete set null,

    -- Why this coin fired: 'trend' | 'meme' | 'random'. trigger_source names the
    -- provider ('coin_intel','trending','x','meme-llm','random'); trigger_detail
    -- carries the structured reason (e.g. the trend, score, source mint).
    kind            text not null check (kind in ('trend', 'meme', 'random')),
    trigger_source  text,
    trigger_detail  jsonb not null default '{}'::jsonb,

    name            text,
    symbol          text,
    mint            text,
    network         text not null default 'mainnet',
    sol_spent       numeric(20, 9) not null default 0,
    buyback_bps     integer,

    -- pending → funded → launched → confirmed, or skipped / failed at any step.
    -- dry_run rows stop at 'dry_run' and never move SOL.
    status          text not null default 'pending'
                    check (status in ('pending', 'dry_run', 'funded', 'launched', 'confirmed', 'skipped', 'failed')),
    dry_run         boolean not null default false,
    tx_signature    text,
    fund_signature  text,
    error           text,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index if not exists launcher_runs_recent_idx on launcher_runs (created_at desc);
create index if not exists launcher_runs_scope_idx on launcher_runs (scope, created_at desc);
create index if not exists launcher_runs_spend_idx on launcher_runs (created_at) where status in ('funded', 'launched', 'confirmed');
create unique index if not exists launcher_runs_mint_uniq on launcher_runs (mint) where mint is not null;

-- Seed a disabled, dry-run global default so the admin UI has a row to edit and
-- the launcher is provably inert until armed.
insert into launcher_config (scope, enabled, dry_run, mode)
values ('global', false, true, 'hybrid')
on conflict do nothing;

commit;

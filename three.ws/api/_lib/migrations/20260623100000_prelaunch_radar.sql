-- Migration: Pre-Launch Creator-Wallet Radar (Task 04 — block-zero pre-cog snipe).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260623100000_prelaunch_radar.sql
-- Idempotent + re-runnable.
--
-- The radar watches the wallets of proven creators (creator_graduated >= N) and
-- proven smart-money wallets (smart_wallet_reputation, task 03) in real time. When
-- a watched wallet funds a brand-new deploy wallet or itself submits a pump.fun
-- create instruction, the radar detects the launch PRECURSOR on-chain — at or
-- before block-0 — and pre-arms a snipe through the existing executor. This is
-- signal on the public on-chain precursor (funding, deploy), never front-running a
-- user's pending mempool transaction.
--
-- Three pieces:
--   1. agent_sniper_strategies — a new trigger='prelaunch_radar' plus radar gates
--      (min_creator_graduated_radar, require_smart_money_funder, radar_max_age_ms).
--   2. radar_watchlist — the auto-curated set of high-signal wallets the radar
--      monitors, with the reason + score it was added for, capped + stale-evicted.
--   3. radar_events — every detected precursor, deduped on (network, signature,
--      kind), read by the API + SSE feed and correlated to the snipe it pre-armed.
--
-- Mainnet-first (pump.fun). Read-only on the graph's tables; writes only its own.

begin;

-- ── strategy trigger + radar gates ───────────────────────────────────────────
-- Extend the trigger enum (named <table>_<column>_check from prior migrations).
alter table agent_sniper_strategies drop constraint if exists agent_sniper_strategies_trigger_check;
alter table agent_sniper_strategies
    add constraint agent_sniper_strategies_trigger_check
    check (trigger in ('new_mint', 'first_claim', 'intel_confirmed', 'prelaunch_radar'));

alter table agent_sniper_positions drop constraint if exists agent_sniper_positions_entry_trigger_check;
alter table agent_sniper_positions
    add constraint agent_sniper_positions_entry_trigger_check
    check (entry_trigger in ('new_mint', 'first_claim', 'intel_confirmed', 'prelaunch_radar'));

alter table agent_sniper_strategies
    -- radar pedigree gate: the triggering creator must have >= this many graduated
    -- coins. null = use the worker's SNIPER_RADAR_MIN_GRADUATED default.
    add column if not exists min_creator_graduated_radar int
        check (min_creator_graduated_radar is null or min_creator_graduated_radar >= 0),
    -- demand the triggering wallet (or the funder of the fresh deploy wallet) is a
    -- proven smart-money address before pre-arming.
    add column if not exists require_smart_money_funder boolean not null default false,
    -- ignore a precursor older than this when first observed (ms). null = worker default.
    add column if not exists radar_max_age_ms int
        check (radar_max_age_ms is null or radar_max_age_ms > 0);

-- The radar poll loop only wants armed prelaunch_radar strategies.
create index if not exists agent_sniper_strategies_radar
    on agent_sniper_strategies (enabled, kill_switch)
    where enabled = true and kill_switch = false and trigger = 'prelaunch_radar';

-- ── auto-curated watchlist ───────────────────────────────────────────────────
-- One row per watched wallet. `reason` is why it's watched; `score` is its 0..100
-- signal strength (creator pedigree or realized reputation). Refreshed on an
-- interval; capped + stale-evicted by the builder so the set stays high-signal.
create table if not exists radar_watchlist (
    address            text not null,
    network            text not null default 'mainnet' check (network in ('mainnet', 'devnet')),
    reason             text not null,                       -- 'creator_graduated' | 'smart_money' | 'manual'
    source             text not null default 'auto',        -- 'auto' | 'manual'
    score              numeric not null default 0,          -- 0..100 signal strength
    creator_graduated  int,                                 -- graduated coins (creator pedigree)
    realized_score     numeric,                             -- 0..100 reputation (smart money)
    labels             text[] not null default '{}',        -- smart_money | strong | creator | ...
    added_at           timestamptz not null default now(),
    refreshed_at       timestamptz not null default now(),  -- last time the builder re-affirmed it
    last_hit_at        timestamptz,                         -- last time a precursor fired from it
    hits               int not null default 0,
    primary key (address, network)
);

create index if not exists radar_watchlist_score
    on radar_watchlist (network, score desc);
create index if not exists radar_watchlist_refreshed
    on radar_watchlist (network, refreshed_at desc);

-- ── detected precursors ──────────────────────────────────────────────────────
-- Every on-chain launch precursor the radar observed. Deduped on
-- (network, signature, kind). `mint` is set once the launch lands (immediately for
-- a create; on correlation for a funding→deploy chain).
create table if not exists radar_events (
    id               uuid primary key default gen_random_uuid(),
    network          text not null default 'mainnet' check (network in ('mainnet', 'devnet')),
    kind             text not null check (kind in ('create', 'funding', 'correlated_mint')),
    trigger_wallet   text not null,                         -- the watched wallet that acted
    new_wallet       text,                                  -- the funded fresh wallet (funding kind)
    mint             text,                                  -- the launched coin, once known
    signature        text not null,                         -- the on-chain tx that proves the precursor
    confidence       numeric not null default 0,            -- 0..1
    watch_reason     text,                                  -- the watchlist reason at fire time
    watch_score      numeric,                               -- the watchlist score at fire time
    detail           jsonb not null default '{}'::jsonb,
    observed_ts      timestamptz,                           -- on-chain block time of the precursor
    created_at       timestamptz not null default now(),
    unique (network, signature, kind)
);

create index if not exists radar_events_recent
    on radar_events (network, created_at desc);
create index if not exists radar_events_wallet
    on radar_events (trigger_wallet);
create index if not exists radar_events_mint
    on radar_events (mint) where mint is not null;

commit;

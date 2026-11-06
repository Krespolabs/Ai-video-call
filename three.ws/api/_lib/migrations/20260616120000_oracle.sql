-- Migration: Oracle — the fused pump.fun conviction layer.
-- Apply: npm run db:migrate  (or psql "$DATABASE_URL" -f this file). Idempotent.
--
-- Oracle sits ON TOP of the platform's full-coverage data brain
-- (pump_coin_intel, pump_coin_wallets, wallet_reputation, coin_smart_money,
-- pump_coin_outcomes). It does NOT re-ingest or duplicate those — it reads them,
-- adds the two things they don't have, and caches the result:
--
--   1. oracle_narrative  — the cultural read (thesis + virality) the LLM produces.
--   2. oracle_conviction — the fused 0–100 score + transparent pillar breakdown,
--                          materialized so the live feed is one fast indexed read
--                          and so we can backtest conviction tiers vs. outcomes.
--   3. oracle_agent_watch / oracle_watch_actions — the agent action loop: a user
--                          arms their 3D agent to act on conviction crossings,
--                          and every (simulated or live) action is logged for
--                          win-rate proof.
--
-- Standalone tables keyed by mint — no cross-system foreign keys, so this
-- migration can apply before/after the brain's own migrations in any order.
-- Mainnet is where pump.fun lives; `network` is carried for parity with the rest.

begin;

-- ── 1. Narrative classification (one row per mint) ───────────────────────────
create table if not exists oracle_narrative (
    mint            text not null,
    network         text not null default 'mainnet' check (network in ('mainnet','devnet')),
    category        text not null default 'unknown',
    narrative       text,                                   -- the thesis, one sentence
    virality        int  not null default 0,                -- 0..100
    confidence      numeric not null default 0,             -- 0..1
    tags            jsonb not null default '[]'::jsonb,
    source          text not null default 'heuristic' check (source in ('llm','heuristic')),
    classified_at   timestamptz not null default now(),
    primary key (mint, network)
);
create index if not exists oracle_narrative_category
    on oracle_narrative (network, category, virality desc);

-- ── 2. Fused conviction (one row per mint, recomputed on a cadence) ──────────
create table if not exists oracle_conviction (
    mint              text not null,
    network           text not null default 'mainnet' check (network in ('mainnet','devnet')),
    symbol            text,
    name              text,
    image_uri         text,

    score             int  not null default 0,              -- 0..100 fused conviction
    tier              text not null default 'avoid',        -- prime|strong|lean|watch|avoid

    pedigree          int  not null default 0,
    structure         int  not null default 0,
    narrative         int  not null default 0,
    momentum          int  not null default 0,
    structure_cap     int  not null default 100,

    badges            jsonb not null default '[]'::jsonb,
    reasons           jsonb not null default '[]'::jsonb,   -- [{pillar,text}]
    components        jsonb not null default '{}'::jsonb,   -- raw normalized inputs (audit trail)

    category          text,                                 -- denormalized for fast feed filters
    smart_wallet_count int not null default 0,

    coin_first_seen_at timestamptz,
    scored_at         timestamptz not null default now(),
    primary key (mint, network)
);
-- Live-feed read: newest, highest-conviction first, filterable by tier/category.
create index if not exists oracle_conviction_feed
    on oracle_conviction (network, score desc, scored_at desc);
create index if not exists oracle_conviction_tier
    on oracle_conviction (network, tier, scored_at desc);
create index if not exists oracle_conviction_fresh
    on oracle_conviction (network, scored_at desc);

-- ── 3. Agent action loop ─────────────────────────────────────────────────────
-- One armed config per (agent, network). The agent auto-acts when a coin's fused
-- conviction crosses `min_score` AND its narrative is in `categories` (empty =
-- any). `mode` defaults to simulate — real spend is opt-in and capped.
create table if not exists oracle_agent_watch (
    agent_id          uuid not null,
    user_id           uuid,
    network           text not null default 'mainnet' check (network in ('mainnet','devnet')),

    armed             boolean not null default false,
    mode              text not null default 'simulate' check (mode in ('simulate','live')),
    min_score         int  not null default 80 check (min_score between 0 and 100),
    min_tier          text not null default 'strong',
    categories        jsonb not null default '[]'::jsonb,   -- [] = any narrative
    per_trade_sol     numeric not null default 0.05,        -- size per action (SOL)
    max_daily_sol     numeric not null default 0.5,
    max_open          int  not null default 5,
    require_smart_money boolean not null default true,      -- only act if ≥1 proven wallet in

    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    primary key (agent_id, network)
);

-- Every action the loop takes (simulated or live) — the win-rate ledger.
create table if not exists oracle_watch_actions (
    id                bigserial primary key,
    agent_id          uuid not null,
    user_id           uuid,
    network           text not null default 'mainnet',
    mint              text not null,
    symbol            text,
    conviction        int,
    tier              text,
    mode              text not null check (mode in ('simulate','live')),
    size_sol          numeric not null default 0,
    status            text not null default 'taken' check (status in ('taken','filled','skipped','failed')),
    reason            text,
    entry_mc_usd      numeric,
    tx_signature      text,
    -- outcome, labeled after the fact by the sweeper (mirrors the brain's loop)
    peak_multiple     numeric,
    realized_pnl_sol  numeric,
    outcome           text,                                 -- win|loss|flat|open
    acted_at          timestamptz not null default now(),
    settled_at        timestamptz
);
create index if not exists oracle_watch_actions_agent
    on oracle_watch_actions (agent_id, network, acted_at desc);
create index if not exists oracle_watch_actions_mint
    on oracle_watch_actions (mint, network);

commit;

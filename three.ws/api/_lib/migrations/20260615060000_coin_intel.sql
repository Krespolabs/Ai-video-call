-- Migration: Coin Intelligence Engine — per-coin observation, wallet ledger,
-- outcome labels, and learned signal weights.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260615060000_coin_intel.sql
-- Idempotent.
--
-- The intel watcher (workers/agent-sniper/intel) subscribes to each new mint's
-- live trade stream for an observation window, records every wallet + every
-- buy/sell, derives bundle/organic/concentration signals, classifies the coin,
-- and persists here. The sniper scorer reads pump_coin_intel + pump_intel_weights
-- to decide. The learning loop labels pump_coin_outcomes after the fact and
-- recomputes pump_intel_weights so judgment improves over time.
--
-- All SOL amounts are lamports (numeric(40,0)) to match agent_sniper_*.

begin;

-- ── one row per observed coin ────────────────────────────────────────────────
create table if not exists pump_coin_intel (
    mint                     text primary key,
    network                  text not null default 'mainnet' check (network in ('mainnet','devnet')),
    symbol                   text,
    name                     text,
    creator                  text,
    bonding_curve            text,
    image_uri                text,
    description              text,
    twitter                  text,
    telegram                 text,
    website                  text,

    created_at               timestamptz,                 -- coin creation (from feed)
    first_seen_at            timestamptz not null default now(),
    observation_ended_at     timestamptz,                 -- when the window closed
    observation_seconds      int,

    -- raw aggregates (window)
    dev_buy_lamports         numeric(40, 0),              -- creator's initial buy
    dev_sold                 boolean not null default false,
    dev_sell_lamports        numeric(40, 0),
    buy_count                int not null default 0,
    sell_count               int not null default 0,
    buy_volume_lamports      numeric(40, 0) not null default 0,
    sell_volume_lamports     numeric(40, 0) not null default 0,
    unique_buyers            int not null default 0,
    unique_sellers           int not null default 0,
    largest_buy_lamports     numeric(40, 0),

    -- derived signals (full structured detail; the columns below are the hot ones)
    signals                  jsonb not null default '{}'::jsonb,
    bundle_score             numeric,                     -- 0..1, coordinated-launch likelihood
    organic_score            numeric,                     -- 0..1, organic-demand likelihood
    snipe_ratio              numeric,                     -- 0..1, buy vol in first seconds
    concentration_top10      numeric,                     -- 0..1, top-10 net-buy share
    fresh_wallet_ratio       numeric,                     -- 0..1, null when enrichment off
    bubblemap_connectivity   numeric,                     -- 0..1, null when enrichment off
    quality_score            int,                         -- 0..100 composite
    risk_flags               text[] not null default '{}',

    -- classification
    category                 text,                        -- meme|tech|ai|culture|community|...
    tags                     text[] not null default '{}',
    narrative                text,
    classify_confidence      numeric,
    classify_source          text,                        -- 'llm' | 'heuristic'

    updated_at               timestamptz not null default now()
);

create index if not exists pump_coin_intel_recent
    on pump_coin_intel (first_seen_at desc);
create index if not exists pump_coin_intel_quality
    on pump_coin_intel (quality_score desc nulls last, first_seen_at desc);
create index if not exists pump_coin_intel_category
    on pump_coin_intel (category, first_seen_at desc);
create index if not exists pump_coin_intel_creator
    on pump_coin_intel (creator);

-- ── per-coin per-wallet aggregate (the "who traded it" ledger) ────────────────
create table if not exists pump_coin_wallets (
    mint                     text not null,
    wallet                   text not null,
    buy_count                int not null default 0,
    sell_count               int not null default 0,
    buy_lamports             numeric(40, 0) not null default 0,
    sell_lamports            numeric(40, 0) not null default 0,
    base_bought              numeric(40, 0) not null default 0,
    base_sold                numeric(40, 0) not null default 0,
    first_seen_at            timestamptz not null default now(),
    last_seen_at             timestamptz not null default now(),
    is_creator               boolean not null default false,
    -- wallet-graph enrichment (null until RPC funder lookup runs)
    funder                   text,
    primary key (mint, wallet)
);

create index if not exists pump_coin_wallets_wallet
    on pump_coin_wallets (wallet);
create index if not exists pump_coin_wallets_funder
    on pump_coin_wallets (funder) where funder is not null;

-- ── ground-truth outcome, labeled after the fact ─────────────────────────────
create table if not exists pump_coin_outcomes (
    mint                     text primary key references pump_coin_intel(mint) on delete cascade,
    labeled_at               timestamptz not null default now(),
    graduated                boolean,
    rugged                   boolean,
    ath_market_cap_usd       numeric,
    ath_multiple             numeric,                     -- ath_mc / mc_at_first_seen
    last_market_cap_usd      numeric,
    outcome                  text                         -- 'graduated'|'pumped'|'flat'|'rugged'|'unknown'
                               check (outcome in ('graduated','pumped','flat','rugged','unknown'))
);

create index if not exists pump_coin_outcomes_outcome
    on pump_coin_outcomes (outcome, labeled_at desc);

-- ── learned per-signal weights (the scorer reads the latest row) ─────────────
create table if not exists pump_intel_weights (
    id                       uuid primary key default gen_random_uuid(),
    network                  text not null default 'mainnet',
    -- map of signal_key -> weight (correlation with good outcomes, -1..1)
    weights                  jsonb not null default '{}'::jsonb,
    sample_size              int not null default 0,
    trained_at               timestamptz not null default now()
);

create index if not exists pump_intel_weights_latest
    on pump_intel_weights (network, trained_at desc);

commit;

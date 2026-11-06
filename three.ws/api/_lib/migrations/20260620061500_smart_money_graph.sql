-- Migration: Smart-Money Wallet Graph & Cluster Intelligence (Task 03).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260620061500_smart_money_graph.sql
-- Idempotent + re-runnable.
--
-- We already record, per launch, every buyer wallet and its funder
-- (pump_coin_wallets) plus eventual outcomes (pump_coin_outcomes:
-- graduated/pumped/rugged/ath_multiple). This migration adds the persistent,
-- self-updating wallet reputation graph that stitches those together:
--
--   1. smart_wallet_reputation — per-wallet realized track record, derived ONLY
--      from observed buys ⋈ real outcomes. A rolling 0..100 realized_score with
--      confidence regression toward neutral until N judged launches, win_rate,
--      avg ATH multiple, and a labels[] array (smart_money / sybil / fresh / …).
--
--   2. smart_wallet_clusters — wallets grouped by a shared funder root via the
--      recompute job's union-find, with a co-occurrence confidence. Sybil/insider
--      clusters are the signal the firewall and Oracle read to discount a launch
--      whose "wide base" is really one funder wearing many wallets.
--
--   3. agent_sniper_strategies gate columns — min_smart_money_score /
--      require_smart_money so a strategy can demand proven money before it buys.
--
-- A DISTINCT namespace from the pre-existing smart-money rollup tables
-- (wallet_reputation / coin_smart_money, migration 20260615080000): this graph is
-- derived from the coin-intel outcome ground truth (pump_coin_outcomes), not from
-- graduations alone, and must not clobber that system's columns or its public API.
--
-- Read-only on the engine's tables. Mainnet-only (pump.fun). Lamports in numeric(40,0).

begin;

-- ── per-wallet realized reputation, folded from outcomes ─────────────────────
create table if not exists smart_wallet_reputation (
    address               text not null,
    network               text not null default 'mainnet' check (network in ('mainnet', 'devnet')),

    -- realized track record (every number traces to an observed buy + an outcome)
    trades_seen           int not null default 0,    -- judged coins this wallet net-bought
    winners               int not null default 0,    -- of those, graduated or pumped (>=3x ATH)
    losers                int not null default 0,     -- of those, flat or rugged
    win_rate              numeric not null default 0, -- winners / trades_seen (0..1)
    avg_ath_multiple      numeric not null default 0, -- mean ATH multiple across judged coins
    realized_score        numeric not null default 0, -- 0..100, ATH-weighted + confidence-regressed

    labels                text[] not null default '{}', -- smart_money | strong | fresh | sybil | rugger | neutral

    first_seen            timestamptz,
    last_seen             timestamptz,
    scored_at             timestamptz not null default now(),
    primary key (address, network)
);

-- By-score lookup (leaderboard / "is this wallet proven").
create index if not exists smart_wallet_reputation_score
    on smart_wallet_reputation (network, realized_score desc);
-- Label lookup (pull the proven cohort fast).
create index if not exists smart_wallet_reputation_labels
    on smart_wallet_reputation using gin (labels);

-- ── funder clusters (union-find over shared-funder edges) ────────────────────
-- One row per (address, network): the cluster it belongs to, the funder root that
-- anchors the cluster, the cluster size, and a 0..1 confidence from how often the
-- members co-occur as buyers of the same launches. cluster_id is the smallest
-- address in the component (deterministic, so reruns are idempotent).
create table if not exists smart_wallet_clusters (
    address               text not null,
    network               text not null default 'mainnet' check (network in ('mainnet', 'devnet')),
    cluster_id            text not null,             -- canonical (smallest) member address
    funder_root           text,                       -- shared funding source anchoring the cluster
    size                  int not null default 1,     -- members in this cluster
    confidence            numeric not null default 0, -- 0..1 co-occurrence confidence
    scored_at             timestamptz not null default now(),
    primary key (address, network)
);

-- Mint-join + "who else is in this wallet's cluster" lookups.
create index if not exists smart_wallet_clusters_cluster
    on smart_wallet_clusters (network, cluster_id);
create index if not exists smart_wallet_clusters_funder
    on smart_wallet_clusters (network, funder_root) where funder_root is not null;

-- ── idempotency cursor: each coin's wallets fold into reputation exactly once ─
-- A coin is folded once its outcome is final; re-running the job re-reads only
-- coins not yet folded (or whose outcome changed), so writes never double-count.
create table if not exists smart_wallet_folded (
    mint                  text not null,
    network               text not null default 'mainnet',
    outcome               text not null,             -- the outcome at fold time
    folded_at             timestamptz not null default now(),
    primary key (mint, network)
);

-- ── strategy gate: demand proven money before buying ─────────────────────────
alter table agent_sniper_strategies
    add column if not exists min_smart_money_score numeric;     -- null = no gate
alter table agent_sniper_strategies
    add column if not exists require_smart_money boolean not null default false;

commit;

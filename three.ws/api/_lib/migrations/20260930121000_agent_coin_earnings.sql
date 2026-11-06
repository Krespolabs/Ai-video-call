-- Migration: per-coin creator-fee earnings snapshot, and the bucketed history
-- behind windowed earnings.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260930121000_agent_coin_earnings.sql
-- Idempotent.
--
-- Filled by api/cron/creator-earnings-snapshot.js, which walks every mainnet
-- coin in pump_agent_mints, reads the coin's on-chain fee recipient (creator),
-- then asks pump.fun's creator-fee index what that wallet has earned and reads
-- its vaults on-chain for what is still unclaimed. Read by
-- GET /api/agents/:id/earnings, GET /api/leaderboard/earnings and the coin page
-- (/api/pump/launch-detail) so no page view has to hit pump.fun.
--
-- agent_coin_earnings: one row per coin. pump.fun reports creator fees per
-- creator WALLET, so every coin of a wallet carries that wallet's figures;
-- wallet_coin_count says how many coins on file share them and
-- wallet_agent_count how many agents those coins belong to. A wallet counts
-- toward an agent's total only when wallet_agent_count = 1, so a figure is
-- never attributed to two agents. refreshed_at is the last SUCCESSFUL read:
-- when pump.fun is down the row keeps its last good figures, records the error
-- and bumps attempted_at only. source = 'unavailable' marks a coin with no
-- figure yet (curve unreadable, non-SOL quote, upstream down on first read).
--
-- creator_fee_buckets: non-zero fee buckets per creator wallet from the same
-- index, '30m' (about the last 50 hours, used for the 24h window) and '1d'
-- (about the last 100 days, used for the 7d and 30d windows).

begin;

create table if not exists agent_coin_earnings (
    mint                text not null,
    network             text not null default 'mainnet',
    agent_id            uuid,
    creator             text,
    earned_lamports     bigint,
    claimed_lamports    bigint,
    unclaimed_lamports  bigint,
    wallet_coin_count   integer not null default 1,
    wallet_agent_count  integer not null default 1,
    source              text not null default 'unavailable'
        check (source in ('pumpfun_creator_fees', 'unavailable')),
    error               text,
    refreshed_at        timestamptz,
    attempted_at        timestamptz not null default now(),
    primary key (mint, network)
);

create index if not exists agent_coin_earnings_agent_idx on agent_coin_earnings (agent_id);
create index if not exists agent_coin_earnings_creator_idx on agent_coin_earnings (creator);

create table if not exists creator_fee_buckets (
    creator          text not null,
    bucket_interval  text not null check (bucket_interval in ('30m', '1d')),
    bucket_start     timestamptz not null,
    fee_lamports     bigint not null default 0,
    num_trades       integer not null default 0,
    refreshed_at     timestamptz not null default now(),
    primary key (creator, bucket_interval, bucket_start)
);

create index if not exists creator_fee_buckets_window_idx on creator_fee_buckets (bucket_interval, bucket_start desc);

commit;

-- Migration: agent-sniper buy-side auto-funding ledger.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260629120000_sniper_funding.sql
-- Idempotent.
--
-- The sniper worker tops up each armed agent's own Solana wallet from the
-- launcher master when it drops below a floor, so a hot sniper never silently
-- runs out of SOL and starts failing every buy. Each master -> agent transfer
-- is recorded here so the daily funding cap survives a worker restart (an
-- in-process accumulator would reset and let the cap be bypassed on a crash
-- loop). It also powers the funding column on the sniper dashboard.
--
-- All SOL amounts are stored as lamports (numeric(40,0)) to avoid float drift.

begin;

create table if not exists sniper_funding_events (
    id            uuid primary key default gen_random_uuid(),
    agent_id      uuid not null references agent_identities(id) on delete cascade,
    wallet        text not null,                                  -- recipient agent solana address
    network       text not null default 'mainnet' check (network in ('mainnet','devnet')),
    lamports      numeric(40, 0) not null,                        -- SOL moved (master -> agent)
    balance_before_lamports numeric(40, 0),                       -- agent balance observed pre-topup
    signature     text,                                           -- transfer signature ('SIMULATED' in simulate mode)
    mode          text not null default 'live' check (mode in ('live','simulate')),
    created_at    timestamptz not null default now()
);

create index if not exists sniper_funding_events_agent
    on sniper_funding_events (agent_id, network, created_at desc);
-- Powers the daily-cap sum: real transfers since the start of the UTC day.
create index if not exists sniper_funding_events_day
    on sniper_funding_events (network, created_at desc)
    where mode = 'live';

commit;

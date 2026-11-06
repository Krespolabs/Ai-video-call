-- Migration: give launcher_claims a real home.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260930120000_launcher_claims.sql
-- Idempotent.
--
-- launcher_claims records every pump.fun creator-fee claim the launcher claimer
-- (api/cron/launcher-claimer.js) makes for an autonomously launched coin. It was
-- created on the fly in two files (the claimer and api/_lib/launcher-engine.js)
-- with no index on agent_id or mint, and nothing read it. Per-agent creator
-- earnings (GET /api/agents/:id/earnings) now join it as the list of claim
-- transactions, which reads by agent_id and by (mint, network).
--
-- Columns match the on-the-fly definition exactly, so production (where the
-- table already exists) only gains the two indexes.

begin;

create table if not exists launcher_claims (
    id               uuid primary key default gen_random_uuid(),
    run_id           uuid references launcher_runs(id) on delete set null,
    agent_id         uuid,
    mint             text not null,
    claimed_lamports bigint not null default 0,
    claimed_sol      float8 not null default 0,
    buyback_sol      float8 not null default 0,
    buyback_sig      text,
    claim_sig        text,
    network          text not null default 'mainnet',
    scope            text not null default 'global',
    created_at       timestamptz not null default now()
);

create index if not exists launcher_claims_run_idx on launcher_claims (run_id, created_at desc);
create index if not exists launcher_claims_created_idx on launcher_claims (created_at desc);
create index if not exists launcher_claims_agent_idx on launcher_claims (agent_id, created_at desc);
create index if not exists launcher_claims_mint_network_idx on launcher_claims (mint, network);

commit;

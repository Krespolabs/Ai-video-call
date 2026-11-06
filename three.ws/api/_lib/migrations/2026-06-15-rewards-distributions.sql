-- Migration: three_rewards_distributions — the holder-rewards (reflections) ledger.
-- Apply: node scripts/apply-migrations.mjs --apply --file 2026-06-15-rewards-distributions.sql
-- Idempotent.
--
-- The $THREE economy NEVER burns. The `rewards` leg of every spend accrues in the
-- rewards pool and is distributed pro-rata back to holders by the rewards cron
-- (api/cron/rewards-distribute.js). This table is the PUBLIC, on-chain-verifiable
-- record of every distribution run — the proof behind the "reflected to holders"
-- figure on /three. Unlike a burn counter, every row here links to real transfers
-- holders can verify on Solscan.
--
-- One row per distribution run. Stores only public facts (pool size, distributed
-- amount, eligible holder count, optional batch tx signatures) — no secrets.

begin;

create table if not exists three_rewards_distributions (
    id                 uuid primary key default gen_random_uuid(),
    mint               text not null,
    -- The rewards pool wallet drained this run (verifiable on-chain).
    pool_wallet        text not null,
    -- Pool balance at run time, what was actually distributed, and the dust
    -- (sub-floor remainder) carried to the next run. All in token atomics.
    pool_atomics       numeric(40, 0) not null,
    distributed_atomics numeric(40, 0) not null default 0,
    dust_atomics       numeric(40, 0) not null default 0,
    -- How many holders were paid, and the eligible supply the split was over.
    holder_count       int not null default 0,
    eligible_supply_atomics numeric(40, 0) not null default 0,
    -- 'planned' (dry run, no signer), 'executing', 'completed', 'failed'.
    status             text not null default 'planned',
    -- The batch transaction signatures, when executed on-chain (verifiable).
    tx_signatures      jsonb not null default '[]'::jsonb,
    -- Free-form note (e.g. why a run was a dry run).
    note               text,
    created_at         timestamptz not null default now()
);

create index if not exists three_rewards_distributions_created
    on three_rewards_distributions (created_at desc);

create index if not exists three_rewards_distributions_status
    on three_rewards_distributions (status, created_at desc);

commit;

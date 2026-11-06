-- Migration: per-dancer wallet registry + payout ledger for the Pole Club sweep.
-- Apply: npm run db:migrate -- --apply --file 2026-05-23-club-dancer-wallets.sql
-- Idempotent.
--
-- Depends on 2026-05-22-club-tips.sql (creates club_tips with the paid_at /
-- paid_tx columns this migration reads). Migration files apply in name order,
-- so 2026-05-22 always runs before 2026-05-23 — no defensive create of
-- club_tips here. The two `alter table … add column if not exists` lines below
-- are belt-and-suspenders only: they are no-ops once 2026-05-22 has been
-- applied (which it must be — club_tips has no other creator).
--
-- club_dancer_wallets is keyed by the dancer slot id ('1'..'4') already used
-- by /api/x402/dance-tip and src/club.js. Each row carries display metadata +
-- the two destination addresses (EVM mainnet on Base 8453, Solana mainnet) the
-- /api/cron/club-payouts sweep deposits accumulated tips into. Addresses are
-- populated via POST /api/admin/club/dancer-wallet or the env-var bootstrap
-- the cron handler performs on every invocation (CLUB_DANCER_EVM_<slot>,
-- CLUB_DANCER_SOL_<slot>). Real addresses are never committed.
--
-- club_payouts is the on-chain receipt ledger: one row per settled sweep tx.
-- Combined with club_tips.paid_at + club_tips.paid_tx (set in the same
-- transaction as the payout row insert), the cron is idempotent: re-running
-- only sweeps tips with paid_at IS NULL.

begin;

create table if not exists club_dancer_wallets (
    dancer          text         primary key,
    display_name    text         not null,
    bio             text,
    evm_address     text,
    solana_address  text,
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now()
);

-- Belt-and-suspenders: ensure the payout settlement columns exist on
-- club_tips. Prompt 07's migration creates them; if some hand-rolled
-- environment is missing them this brings it back in line.
alter table club_tips add column if not exists paid_at timestamptz;
alter table club_tips add column if not exists paid_tx text;

-- Cron query filter: unpaid tips grouped by (dancer, network, asset).
-- Partial index keeps it small — paid rows are not indexed once swept.
create index if not exists club_tips_unpaid_by_dancer_net
    on club_tips (dancer, network, asset)
    where paid_at is null;

create table if not exists club_payouts (
    id                uuid        primary key default gen_random_uuid(),
    dancer            text        not null references club_dancer_wallets(dancer),
    network           text        not null,   -- 'solana' | 'base'
    asset             text        not null,   -- USDC mint (sol) or contract (evm)
    amount_atomics    numeric     not null,
    tx                text        not null,   -- on-chain signature / hash
    swept_tip_count   integer     not null,
    created_at        timestamptz not null default now()
);

create index if not exists club_payouts_dancer_created
    on club_payouts (dancer, created_at desc);

-- Seed the four built-in stage slots with the display names hard-coded in
-- /api/x402/dance-tip and src/club.js. Addresses stay NULL until an admin
-- sets them; the cron logs + skips (dancer, network) pairs where the
-- destination address is missing.
insert into club_dancer_wallets (dancer, display_name) values
    ('1', 'Nyx'),
    ('2', 'Ari'),
    ('3', 'Sable'),
    ('4', 'Vesper')
on conflict (dancer) do update
    set display_name = excluded.display_name,
        updated_at   = now();

commit;

-- Migration: Pole Club door ban list.
-- Apply: npm run db:migrate -- --apply --file 2026-06-15-club-bans.sql
-- Idempotent.
--
-- Backs the on-chain bouncer at /api/x402/club-cover. A wallet listed here is
-- turned away at the door even after paying the cover charge — the cover
-- endpoint looks the payer's wallet up against this table and returns
-- admitted=false when a row exists. Default empty: nobody is banned until an
-- operator adds a row. Keyed on the lowercased wallet so Base (0x…) and
-- Solana (base58) addresses compare consistently with how the cover endpoint
-- normalizes the payer.

begin;

create table if not exists club_bans (
    wallet      text        primary key,
    reason      text,
    banned_by   text,
    banned_at   timestamptz not null default now()
);

commit;

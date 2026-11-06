-- Migration: persistent ledger for Pole Club tip events.
-- Apply: npm run db:migrate -- --apply --file 2026-05-22-club-tips.sql
-- Idempotent.
--
-- Backs the /club "Live tips" feed. Every settled /api/x402/dance-tip
-- payment writes one row here, /api/club/tips reads recent rows for the
-- page boot, and /api/club/tips/stream tails the table for the SSE feed.
--
-- paid_at / paid_tx are reserved for prompt 08 (dancer payouts) — schema
-- carries them now so payouts don't require a second migration.

begin;

create table if not exists club_tips (
    id              uuid        primary key default gen_random_uuid(),
    ticket_id       text        not null unique,
    dancer          text        not null,
    dance           text        not null,
    clip            text,
    label           text,
    payer           text,
    network         text,
    amount_atomics  numeric,
    asset           text,
    started_at      timestamptz not null,
    ends_at         timestamptz not null,
    paid_at         timestamptz,
    paid_tx         text,
    created_at      timestamptz not null default now()
);

create index if not exists club_tips_created_at_desc
    on club_tips (created_at desc);

create index if not exists club_tips_dancer_created
    on club_tips (dancer, created_at desc);

commit;

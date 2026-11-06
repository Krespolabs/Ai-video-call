-- Migration: the /go bounty board tables (bounties + bounty_submissions).
--
-- These tables were originally created out-of-band by scripts/migrate-bounties.sql
-- (a manual `psql -f` one-off) and were never carried as a runner migration. The
-- migration runner (scripts/apply-migrations.mjs) applies ONLY
-- api/_lib/migrations/*.sql — it does not run that script — so any database
-- provisioned without the manual step is missing them. api/bounties.js queries
-- both on every request, so on such a database the board 500s with:
--
--   NeonDbError: relation "bounties" does not exist
--   NeonDbError: relation "bounty_submissions" does not exist
--
-- This backfills them through the canonical runner path. Dated 2026-06-07 — one
-- day before 2026-06-08-bounty-likes.sql — on purpose: that migration creates
-- bounty_submission_likes with a foreign key REFERENCES bounty_submissions(id),
-- so on a fresh database these base tables MUST be created first or the likes
-- migration fails. Lexicographic ordering ('2026-06-07' < '2026-06-08') guarantees
-- that. Everything is `if not exists`, so this is a safe no-op on databases that
-- already ran the manual script.
begin;

create table if not exists bounties (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  username      text,
  title         text not null,
  description   text,
  coin_symbol   text not null default '$THREE',
  coin_mint     text not null default 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
  reward_sol    numeric(18,9),
  reward_tokens numeric(30,0),
  reward_usd    numeric(10,2),
  status        text not null default 'open' check (status in ('open','resolving','closed')),
  expires_at    timestamptz not null default (now() + interval '7 days'),
  submission_count integer not null default 0,
  winner_submission_id uuid,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists bounties_status_idx  on bounties(status)    where deleted_at is null;
create index if not exists bounties_user_idx    on bounties(user_id)   where deleted_at is null;
create index if not exists bounties_created_idx on bounties(created_at desc) where deleted_at is null;
create index if not exists bounties_subs_idx    on bounties(submission_count desc) where deleted_at is null;

create table if not exists bounty_submissions (
  id          uuid primary key default gen_random_uuid(),
  bounty_id   uuid not null references bounties(id) on delete cascade,
  user_id     uuid not null,
  username    text,
  content     text,
  media_url   text,
  media_type  text check (media_type in ('image','video','link')),
  status      text not null default 'pending' check (status in ('pending','accepted','rejected')),
  reward_sol  numeric(18,9),
  tx_hash     text,
  created_at  timestamptz not null default now()
);

create index if not exists bs_bounty_idx  on bounty_submissions(bounty_id);
create index if not exists bs_user_idx    on bounty_submissions(user_id);
create index if not exists bs_created_idx on bounty_submissions(created_at desc);
create index if not exists bs_status_idx  on bounty_submissions(status);

commit;

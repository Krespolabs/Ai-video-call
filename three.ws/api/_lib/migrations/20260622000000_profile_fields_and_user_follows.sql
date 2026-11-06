-- Migration: profile free-text fields + the user_follows social graph.
--
-- These objects were defined in api/_lib/schema.sql but never carried their own
-- migration, so production databases provisioned before they were added to the
-- base schema are missing them. That surfaced as live 500s in the logs:
--
--   NeonDbError: column "bio" does not exist          (api/users/:username/follows.js, profile reads)
--   NeonDbError: relation "user_follows" does not exist (follow toggle, feed fan-out, counts)
--
-- apply-migrations.mjs only runs api/_lib/migrations/*.sql — it does NOT re-apply
-- schema.sql — so the fix has to live here. Everything is `if not exists`, so this
-- is safe on databases that already have some or all of these from a schema.sql run.
begin;

-- ── Profile free-text fields (set via PATCH /api/auth/profile) ────────────────
-- All nullable; a profile with none set still renders from the user's content.
alter table users add column if not exists bio        text;
alter table users add column if not exists website    text;
alter table users add column if not exists location   text;
alter table users add column if not exists banner_url text;

-- ── user_follows — the directed social graph ─────────────────────────────────
-- follower_id follows following_id. Composite PK makes a follow idempotent (one
-- edge per pair) and the toggle a single upsert/delete. The check blocks
-- self-follows at the storage layer. Two covering indexes back the hot reads:
-- "who follows X" and "who X follows" (incl. the feed fan-out join).
create table if not exists user_follows (
    follower_id   uuid not null references users(id) on delete cascade,
    following_id  uuid not null references users(id) on delete cascade,
    created_at    timestamptz not null default now(),
    primary key (follower_id, following_id),
    check (follower_id <> following_id)
);
create index if not exists user_follows_following on user_follows(following_id, created_at desc);
create index if not exists user_follows_follower  on user_follows(follower_id, created_at desc);

commit;

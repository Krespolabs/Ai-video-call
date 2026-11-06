-- Walk metrics, events, and achievements.
--
-- Powers two product surfaces from one ingest pipeline (POST /api/walk/metrics):
--   · /walk-leaderboard — public gamified ranking of walkers by distance, sites
--     visited, and time spent walking, over daily / weekly / all-time windows.
--   · /walk-analytics    — per-creator dashboard for the embedded walking avatar:
--     sessions, average duration, distance, unique embed origins, a conversion
--     funnel of creator-defined events, and the top embed locations.
--
-- A "walker" is attributed to the signed-in user when a session/bearer is present
-- and otherwise to a stable anonymous id (anon_id) the client supplies. Either
-- column may be null but never both — enforced by the check constraint below.
--
-- Rollup model: client batches arrive every ~60s (and on pagehide via
-- sendBeacon). Rather than store one row per frame, each batch UPSERTs into a
-- per-(walker, day, environment, embed origin) rollup row, so the leaderboard and
-- analytics aggregate over a compact, indexed table no matter how long anyone
-- walks. `day` is the UTC date the batch landed; period windows are derived from
-- it at read time.
--
-- Fully idempotent — safe to re-run. Mirrored into api/_lib/schema.sql.

-- ── walk_metrics — per-(walker, day, env, origin) rollup ─────────────────────
create table if not exists walk_metrics (
    id              bigserial primary key,
    user_id         uuid references users(id) on delete cascade,
    anon_id         text,                       -- stable anonymous walker id (client-generated)
    avatar_id       uuid references avatars(id) on delete set null,
    day             date not null,              -- UTC date the batch landed
    env_id          text,                       -- walk environment name (park, void, …)
    embed_origin    text,                       -- iframe host the avatar walked on (server-derived)
    site_hostname   text,                       -- extension-reported host the avatar piloted
    distance_meters double precision not null default 0,
    duration_sec    double precision not null default 0,
    sessions        integer not null default 0,
    updated_at      timestamptz not null default now(),
    created_at      timestamptz not null default now(),
    -- A rollup must belong to exactly one walker identity.
    constraint walk_metrics_walker_present check (user_id is not null or anon_id is not null)
);

-- One rollup row per walker identity × day × env × embed origin. The COALESCE'd
-- expression unique index lets the ingest UPSERT target a single row even when
-- some dimensions are null (anonymous walker, no embed origin, etc.) — Postgres
-- treats NULLs as distinct in a plain unique index, which would otherwise spawn a
-- new row per batch and break the rollup.
create unique index if not exists walk_metrics_rollup_uniq
    on walk_metrics (
        coalesce(user_id::text, ''),
        coalesce(anon_id, ''),
        day,
        coalesce(env_id, ''),
        coalesce(embed_origin, ''),
        coalesce(avatar_id::text, '')
    );

-- Leaderboard: sum metrics per walker within a date window.
create index if not exists walk_metrics_user_day on walk_metrics (user_id, day) where user_id is not null;
create index if not exists walk_metrics_anon_day on walk_metrics (anon_id, day) where anon_id is not null;
-- Analytics: per-avatar reads filtered + grouped by day, env, origin.
create index if not exists walk_metrics_avatar_day on walk_metrics (avatar_id, day) where avatar_id is not null;
create index if not exists walk_metrics_origin on walk_metrics (avatar_id, embed_origin) where avatar_id is not null;

-- ── walk_events — creator-defined conversion events fired from the embed SDK ──
-- track('subscribe', { plan:'pro' }) → one row. Aggregated against session counts
-- in the analytics dashboard to compute a conversion rate per event name.
create table if not exists walk_events (
    id              bigserial primary key,
    user_id         uuid references users(id) on delete set null,
    anon_id         text,
    avatar_id       uuid references avatars(id) on delete set null,
    event_name      text not null,
    value           double precision,           -- optional numeric value (revenue, plan tier, …)
    embed_origin    text,                        -- server-derived iframe host
    created_at      timestamptz not null default now()
);

create index if not exists walk_events_avatar_time on walk_events (avatar_id, created_at desc) where avatar_id is not null;
create index if not exists walk_events_avatar_name on walk_events (avatar_id, event_name) where avatar_id is not null;

-- ── walk_achievements — unlocked badges per walker ───────────────────────────
-- One row per (walker, achievement code). The client fires the toast optimistically
-- on threshold crossing; the server persists the unlock so it is awarded once and
-- can be surfaced on profiles / the leaderboard later.
create table if not exists walk_achievements (
    id              bigserial primary key,
    user_id         uuid references users(id) on delete cascade,
    anon_id         text,
    code            text not null,               -- distance_1km | sites_10 | all_environments | …
    unlocked_at     timestamptz not null default now(),
    constraint walk_achievements_walker_present check (user_id is not null or anon_id is not null)
);

create unique index if not exists walk_achievements_uniq
    on walk_achievements (
        coalesce(user_id::text, ''),
        coalesce(anon_id, ''),
        code
    );
create index if not exists walk_achievements_user on walk_achievements (user_id) where user_id is not null;

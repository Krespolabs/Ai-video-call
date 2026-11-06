-- Walk session persistence — resume-where-you-left-off for the /walk runtime.
--
-- One row per signed-in user holds the last snapshot of their walk state so
-- returning to /walk (on any device) resumes from where they left off instead of
-- starting over. Anonymous walkers persist the same shape to localStorage in the
-- browser; only authenticated users sync here, which is what gives cross-device
-- continuity (walk on a laptop, reopen on a phone, same state restored).
--
-- The snapshot is a single jsonb document rather than a wide column set: the walk
-- client owns the shape (avatar id, environment, camera mode, position/heading,
-- trail style, recent gestures, companion prefs, multiplayer room) and it evolves
-- with the runtime, so a schema-less document avoids a migration per new field.
-- The server still validates the document with zod (api/walk/session.js) before
-- it is written, so a malformed/hostile client can't store arbitrary blobs.
--
-- One row per user (PK = user_id), upserted on every save (last-write-wins).
-- updated_at drives the "< 7 days old" freshness gate the client applies on
-- restore, and lets a future sweep reclaim long-abandoned rows.
--
-- Idempotent — safe to re-run.

create table if not exists walk_sessions (
    user_id     uuid primary key references users(id) on delete cascade,
    -- The full client-owned snapshot. Validated by api/walk/session.js before
    -- write; never trusted as-is on read beyond shape.
    state       jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- Freshness / sweep ordering: the most recently touched sessions first, and a
-- cheap predicate for a background reclaim of rows older than the restore window.
create index if not exists walk_sessions_updated_at
    on walk_sessions (updated_at desc);

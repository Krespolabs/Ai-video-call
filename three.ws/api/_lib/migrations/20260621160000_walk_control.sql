-- Walk programmatic-control sessions + command queue.
--
-- Powers the REST control surface (api/walk/control/[action].js) that lets an
-- external system — another agent, a CI bot, a webhook — drive a *running* walk
-- page: move the avatar to a world position, trigger a gesture, make it speak, or
-- swap the environment live.
--
-- Two principals, two credentials:
--   · The CONTROLLER creates a session (POST /session) and pushes commands. It
--     authenticates the create call as the avatar owner (cookie/bearer) and then
--     holds the returned `controlToken` (an opaque secret, stored hashed) to push
--     and to read state.
--   · The WALK CLIENT (src/walk.js, opened with ?control=<sessionId>&ck=<token>)
--     short-polls /session (or /poll) with the same controlToken to drain queued
--     commands and apply them to the real scene, and reports its live position
--     back so the controller's /state read reflects the actual avatar.
--
-- A command is enqueued once, delivered once: the poll claims undelivered rows
-- for the session in fifo order and stamps delivered_at, so a command is never
-- replayed across polls. Idempotency: a controller may pass a client-supplied
-- `dedup_key` per (session, kind) so a retried push collapses onto the same row
-- instead of enqueuing a duplicate move/say.
--
-- Sessions are ephemeral. `expires_at` bounds a session's life; a background
-- sweep (or a lazy delete on access) reclaims expired sessions and their
-- commands. Commands cascade-delete with their session.
--
-- Fully idempotent — safe to re-run. Mirrored into api/_lib/schema.sql.

-- ── walk_control_sessions — one row per live control session ─────────────────
create table if not exists walk_control_sessions (
    id              uuid primary key default gen_random_uuid(),
    owner_id        uuid not null references users(id) on delete cascade,
    avatar_id       uuid references avatars(id) on delete set null,
    -- The controlToken handed to the controller, stored only as a SHA-256 hex
    -- digest. The plaintext is returned once at creation and never persisted.
    token_hash      text not null,
    label           text,                        -- optional human label for the session
    env_id          text,                        -- requested initial environment
    -- Live avatar state, reported by the walk client on each poll. Null until the
    -- client first checks in. pos_x/pos_z are world metres; facing is radians.
    pos_x           double precision,
    pos_z           double precision,
    facing          double precision,
    motion          text,                        -- idle | walk | run (client-reported)
    current_env     text,                        -- env the client actually has loaded
    -- Lifecycle timestamps.
    client_seen_at  timestamptz,                 -- last time the walk client polled
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null
);

create index if not exists walk_control_sessions_owner
    on walk_control_sessions (owner_id, created_at desc);
create index if not exists walk_control_sessions_token
    on walk_control_sessions (token_hash);
create index if not exists walk_control_sessions_expires
    on walk_control_sessions (expires_at);

-- ── walk_control_commands — fifo command queue per session ───────────────────
-- kind ∈ move | gesture | say | env. `payload` carries the kind-specific args
-- ({x,z,speed} | {gesture} | {text,voice} | {env}). delivered_at is null until a
-- poll claims it; once stamped the command is never handed out again.
create table if not exists walk_control_commands (
    id              bigserial primary key,
    session_id      uuid not null references walk_control_sessions(id) on delete cascade,
    seq             bigint not null,             -- monotonic per-session ordering
    kind            text not null check (kind in ('move','gesture','say','env')),
    payload         jsonb not null default '{}'::jsonb,
    dedup_key       text,                        -- optional controller-supplied idempotency key
    created_at      timestamptz not null default now(),
    delivered_at    timestamptz                  -- set when a poll claims the row
);

-- Drain order + "undelivered for this session" lookups.
create index if not exists walk_control_commands_drain
    on walk_control_commands (session_id, seq)
    where delivered_at is null;

-- Idempotent push: a retried controller call carrying the same (session, kind,
-- dedup_key) collapses onto the existing row rather than enqueuing a duplicate.
-- Partial unique index so commands without a dedup_key are unconstrained.
create unique index if not exists walk_control_commands_dedup
    on walk_control_commands (session_id, kind, dedup_key)
    where dedup_key is not null;

-- usage_events — quota / analytics / billing event log.
--
-- This table is defined in api/_lib/schema.sql but the production migration
-- runner (scripts/run-migrations.mjs) only applies api/_lib/migrations/*.sql,
-- so a prod DB provisioned purely from the migration stream never received it.
-- That surfaced as `NeonDbError: relation "usage_events" does not exist`
-- (code 42P01) on /api/agents/[id] and every billing/usage read.
--
-- This migration reconciles the drift: it (re)creates the table, its indexes,
-- and the additive agent_id column exactly as schema.sql declares them. Fully
-- idempotent — safe to run against a DB that already has the table.

create table if not exists usage_events (
    id              bigserial primary key,
    user_id         uuid references users(id) on delete set null,
    api_key_id      uuid references api_keys(id) on delete set null,
    client_id       text references oauth_clients(client_id) on delete set null,
    avatar_id       uuid references avatars(id) on delete set null,
    kind            text not null,
    tool            text,
    status          text not null default 'ok',
    bytes           bigint,
    latency_ms      int,
    meta            jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);

create index if not exists usage_events_user_time on usage_events(user_id, created_at desc);
create index if not exists usage_events_kind_time on usage_events(kind, created_at desc);

-- Additive: agent attribution (see schema.sql "Additive migrations for usage_events").
alter table usage_events add column if not exists agent_id uuid references agent_identities(id) on delete set null;
create index if not exists usage_events_agent_time on usage_events(agent_id, created_at desc) where agent_id is not null;

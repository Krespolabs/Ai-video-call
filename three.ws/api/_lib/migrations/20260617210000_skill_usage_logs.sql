-- Skill usage telemetry: every paid skill execution is logged here.
-- Used by /api/creators/skill-analytics to surface usage metrics to creators.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260617210000_skill_usage_logs.sql
-- Idempotent.

begin;

create table if not exists skill_usage_logs (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid references users(id) on delete set null,
    agent_id            uuid not null references agent_identities(id) on delete cascade,
    skill_name          text not null,
    status              text not null default 'success'
                        check (status in ('success', 'failure')),
    execution_time_ms   integer,
    created_at          timestamptz not null default now()
);

create index if not exists idx_skill_usage_agent on skill_usage_logs(agent_id, created_at desc);
create index if not exists idx_skill_usage_skill on skill_usage_logs(agent_id, skill_name, created_at desc);

commit;

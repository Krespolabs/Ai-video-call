begin;

-- Agent Genome: provable breeding lineage table.
-- Pulled from api/_lib/schema.sql where it was defined but never applied as a
-- standalone migration. The NeonDbError "relation genome_breedings does not exist"
-- was surfacing on /api/genome/lineage and /api/genome/breed for all prod users.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

create table if not exists genome_breedings (
    id                 uuid primary key default gen_random_uuid(),
    breeding_key       text not null unique,
    parent_a_agent_id  uuid not null references agent_identities(id) on delete cascade,
    parent_b_agent_id  uuid not null references agent_identities(id) on delete cascade,
    child_agent_id     uuid references agent_identities(id) on delete set null,
    seed               text not null,
    genome             jsonb not null,
    genome_hash        text not null,
    generation         integer not null default 1,
    pedigree_tier      text not null default 'common',
    bred_by            uuid not null references users(id),
    stud_fee_lamports  bigint not null default 0,
    stud_fee_signature text,
    consent_owner      uuid references users(id),
    status             text not null default 'born'
                       check (status in ('pending','born','failed')),
    created_at         timestamptz not null default now()
);

create index if not exists genome_breedings_parent_a
    on genome_breedings (parent_a_agent_id, created_at desc);
create index if not exists genome_breedings_parent_b
    on genome_breedings (parent_b_agent_id, created_at desc);
create index if not exists genome_breedings_child
    on genome_breedings (child_agent_id) where child_agent_id is not null;
create index if not exists genome_breedings_bred_by
    on genome_breedings (bred_by, created_at desc);

commit;

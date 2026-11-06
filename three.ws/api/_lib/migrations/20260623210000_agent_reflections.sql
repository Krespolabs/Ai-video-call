-- Reflection & Dreams — memory consolidation engine (Living Agents · Task 04).
--
-- An agent periodically *reflects*: it reads its own recent raw memories and
-- action log and synthesizes higher-order insights ("dreams"). Each dream is a
-- candidate the owner reviews — accept turns it into a real, higher-salience
-- memory (and/or a proposed Autopilot rule); reject is itself stored so future
-- reflections learn from the rejection.
--
-- Two tables:
--   agent_reflections      — the dreams themselves (one row per candidate insight)
--   agent_reflection_runs  — one row per reflection pass, even when it produced
--                            zero dreams or was skipped. This is what enforces the
--                            per-agent daily cap + debounce WITHOUT a silent cap:
--                            every skip records its reason here.

create table if not exists agent_reflections (
    id                 uuid primary key default gen_random_uuid(),
    agent_id           uuid not null references agent_identities(id) on delete cascade,
    status             text not null default 'pending'
                           check (status in ('pending', 'accepted', 'rejected')),
    -- The kind of consolidation. 'insight' = a noticed pattern; 'belief' = a
    -- synthesized user/feedback fact; 'question' = a low-confidence clarification
    -- the agent wants the user to answer; 'prune' = a proposal to merge/forget.
    kind               text not null default 'insight'
                           check (kind in ('insight', 'belief', 'question', 'prune')),
    statement          text not null,
    rationale          text,
    confidence         real not null default 0.5 check (confidence >= 0 and confidence <= 1),
    -- Provenance is mandatory: every dream cites the raw memory ids it drew from.
    source_memory_ids  uuid[] not null default '{}',
    proposed_type      text check (proposed_type in ('user', 'feedback', 'project', 'reference')),
    proposed_salience  real not null default 0.7 check (proposed_salience >= 0 and proposed_salience <= 1),
    proposed_action    jsonb,
    -- For kind='question': the clarification asked, and the user's answer if given.
    question           text,
    answer             text,
    run_id             uuid,
    -- The memory row written when this dream is accepted (provenance for the
    -- accept side: lets the UI link the dream to the memory it became).
    accepted_memory_id uuid,
    created_at         timestamptz not null default now(),
    reviewed_at        timestamptz
);

create index if not exists agent_reflections_agent_status
    on agent_reflections(agent_id, status, created_at desc);

create index if not exists agent_reflections_run
    on agent_reflections(run_id)
    where run_id is not null;

create table if not exists agent_reflection_runs (
    id             uuid primary key default gen_random_uuid(),
    agent_id       uuid not null references agent_identities(id) on delete cascade,
    trigger        text not null check (trigger in ('cron', 'on-demand', 'manual')),
    status         text not null check (status in ('ok', 'skipped', 'error')),
    reason         text,
    dreams_created integer not null default 0,
    candidates     integer not null default 0,
    model          text,
    input_tokens   integer,
    output_tokens  integer,
    created_at     timestamptz not null default now()
);

create index if not exists agent_reflection_runs_agent_time
    on agent_reflection_runs(agent_id, created_at desc);

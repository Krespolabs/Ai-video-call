-- Memory-grounded Autopilot — explainable autonomy (Living Agents · Task 08).
--
-- The agent proposes and (within user-granted scope) takes REAL actions —
-- creating pump alert rules, authoring briefings, transferring $THREE — and
-- every action is traceable to the memory or reflection that motivated it.
--
-- Permission/scope is stored on agent_identities.meta.autopilot (same slot
-- convention as meta.strategy / meta.spend_limits). This table is the proposal
-- queue: the "mind" (high-salience memories + accepted/pending dreams) generates
-- candidates here; the owner approves / dry-runs / dismisses; on execution the
-- real action is recorded in agent_actions (signed) and linked back via
-- executed_action_id. Provenance (source_memory_ids + source_reflection_id) is
-- mandatory — a proposal that cites nothing is never written.

create table if not exists agent_autopilot_proposals (
    id                    uuid primary key default gen_random_uuid(),
    agent_id              uuid not null references agent_identities(id) on delete cascade,
    user_id               uuid not null references users(id) on delete cascade,
    -- The real action this proposal would take when executed.
    --   create_alert    → inserts a pump_alert_rules row (reversible)
    --   briefing        → authors a memory-grounded briefing notification (reversible)
    --   wallet_transfer → sends $THREE from the agent's custodial wallet (irreversible)
    kind                  text not null
                              check (kind in ('create_alert', 'briefing', 'wallet_transfer')),
    title                 text not null,
    -- The receipt: plain-language "I want to do X because …" the owner reads.
    rationale             text not null,
    -- Concrete, validated action parameters (e.g. the alert-rule body, the
    -- transfer recipient + $THREE amount, the briefing cadence).
    params                jsonb not null default '{}'::jsonb,
    -- Provenance is mandatory: every proposal cites the raw memory ids and/or the
    -- reflection it was derived from. CHECK enforces at least one source.
    source_memory_ids     uuid[] not null default '{}',
    source_reflection_id  uuid references agent_reflections(id) on delete set null,
    confidence            real not null default 0.6 check (confidence >= 0 and confidence <= 1),
    -- Irreversible actions (spends/publishes) default to requiring an explicit
    -- confirmation at execution time unless the owner durably pre-authorized.
    requires_confirmation boolean not null default true,
    status                text not null default 'pending'
                              check (status in ('pending', 'executed', 'dismissed', 'undone', 'failed')),
    -- The append-only agent_actions row id written when this proposal executed —
    -- the signed receipt the Activity surface links to.
    executed_action_id    bigint,
    -- Execution outcome: created rule id, tx signature, error string, undo info.
    result                jsonb not null default '{}'::jsonb,
    created_at            timestamptz not null default now(),
    decided_at            timestamptz,
    executed_at           timestamptz,
    constraint agent_autopilot_proposals_has_source
        check (array_length(source_memory_ids, 1) > 0 or source_reflection_id is not null)
);

create index if not exists agent_autopilot_proposals_agent_status
    on agent_autopilot_proposals(agent_id, status, created_at desc);

create index if not exists agent_autopilot_proposals_user
    on agent_autopilot_proposals(user_id, created_at desc);

-- One pending proposal per reflection — re-running the generator must not
-- enqueue the same dream twice.
create unique index if not exists agent_autopilot_proposals_reflection_pending
    on agent_autopilot_proposals(source_reflection_id)
    where source_reflection_id is not null and status = 'pending';

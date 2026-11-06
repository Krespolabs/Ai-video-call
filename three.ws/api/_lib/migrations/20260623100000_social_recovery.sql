begin;

-- Social recovery & inheritance for custodial agent wallets.
--
-- Agent Solana/EVM wallets are custodial: the platform holds the AES-GCM
-- encrypted secret and signs server-side, and the single owner is
-- agent_identities.user_id. That makes "I lost access" or "the owner is gone"
-- survivable WITHOUT ever exporting a key — recovery/inheritance change *who the
-- owner is* (the user_id), never the encrypted secret, which keeps signing for
-- the new owner exactly as before.
--
-- Three tables model the social graph + the threshold-approved, time-locked
-- process. The owner-set threshold and dead-man's-switch config live on
-- agent_identities.meta.recovery (jsonb) — same convention as meta.spend_limits —
-- so this migration is purely the relational/audit side.

-- ── guardians + beneficiary roster ─────────────────────────────────────────────
-- Who can help recover (guardians) and who inherits (beneficiary). Both reference
-- REAL accounts (users.id). A user may be both a guardian and the beneficiary
-- (two rows, distinct role). Reverse lookup (guardian_user_id, status) powers the
-- guardian inbox: "the agents I'm trusted to recover".
create table if not exists agent_recovery_guardians (
    id                bigserial   primary key,
    agent_id          uuid        not null,
    guardian_user_id  uuid        not null references users(id) on delete cascade,
    role              text        not null default 'guardian',  -- guardian | beneficiary
    status            text        not null default 'active',    -- active | removed
    added_by          uuid,                                     -- owner who set it (audit)
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- One active row per (agent, user, role): re-adding a removed guardian flips the
-- existing row back to active rather than duplicating.
create unique index if not exists agent_recovery_guardians_unq
    on agent_recovery_guardians (agent_id, guardian_user_id, role);

create index if not exists agent_recovery_guardians_inbox
    on agent_recovery_guardians (guardian_user_id, status)
    where status = 'active';

create index if not exists agent_recovery_guardians_agent
    on agent_recovery_guardians (agent_id, status);

-- ── recovery / inheritance requests ────────────────────────────────────────────
-- One ongoing process to hand control of an agent to a new owner. `kind`
-- distinguishes an owner-driven recovery from a dead-man's-switch inheritance.
-- The process is threshold-approved (approvals_required) AND time-locked
-- (timelock_until) so a single impostor — or a single compromised guardian —
-- can never take over: the real owner has the whole window to cancel by simply
-- being active.
create table if not exists agent_recovery_requests (
    id                 uuid        primary key default gen_random_uuid(),
    agent_id           uuid        not null,
    kind               text        not null,                       -- recovery | inheritance
    status             text        not null default 'pending_approvals',
        -- pending_approvals | time_locked | ready | completed | cancelled | rejected | expired
    requester_id       uuid,                                       -- initiator (null = system/cron)
    prev_owner_id      uuid        not null,                       -- owner at request time
    new_owner_id       uuid        not null,                       -- nominee who gains control
    approvals_required int         not null default 1,
    timelock_until     timestamptz,                                -- set once threshold is met
    reason             text,
    meta               jsonb       not null default '{}'::jsonb,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    completed_at       timestamptz
);

-- Serialize: at most ONE active process per agent. A second recovery attempt
-- (an impostor racing the owner, or a duplicate click) is refused at the DB
-- level rather than racing two transfers.
create unique index if not exists agent_recovery_requests_one_active
    on agent_recovery_requests (agent_id)
    where status in ('pending_approvals', 'time_locked', 'ready');

create index if not exists agent_recovery_requests_agent_time
    on agent_recovery_requests (agent_id, created_at desc);

create index if not exists agent_recovery_requests_active
    on agent_recovery_requests (status)
    where status in ('pending_approvals', 'time_locked', 'ready');

-- ── guardian votes ─────────────────────────────────────────────────────────────
-- One vote per guardian per request; a re-vote overwrites the prior decision.
-- Counted at evaluation time by JOINing against the CURRENT active guardian
-- roster, so a guardian removed (or whose account was deleted) mid-process no
-- longer counts — no stale approvals can push a takeover over the threshold.
create table if not exists agent_recovery_approvals (
    id                bigserial   primary key,
    request_id        uuid        not null references agent_recovery_requests(id) on delete cascade,
    guardian_user_id  uuid        not null references users(id) on delete cascade,
    decision          text        not null,                        -- approve | decline
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create unique index if not exists agent_recovery_approvals_unq
    on agent_recovery_approvals (request_id, guardian_user_id);

comment on table agent_recovery_guardians is
    'Per-agent guardian + beneficiary roster for social recovery / inheritance of '
    'custodial agent wallets. role = guardian|beneficiary. Owner-managed; reverse '
    'lookup (guardian_user_id) powers the guardian inbox. Threshold + dead-man '
    'config live in agent_identities.meta.recovery.';

comment on table agent_recovery_requests is
    'Threshold-approved, time-locked process to transfer agent ownership '
    '(agent_identities.user_id) to a new owner — no key is ever exported. '
    'One active row per agent (partial unique index). Completion is atomic and '
    'audited in agent_custody_events as an ownership_transfer.';

commit;

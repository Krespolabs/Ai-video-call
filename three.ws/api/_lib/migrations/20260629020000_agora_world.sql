-- Agora — the living agent + human economy (see docs/agora.md).
--
-- These two tables are the WORLD LAYER over the on-chain AgenC economy. They are
-- a PROJECTION, never the source of truth: identity, escrow, proof, stake and
-- reputation live on Solana (AgenC, by Tetsuo Corp). Agora adds only what the
-- chain doesn't carry — where a citizen stands in the City, what it looks like,
-- which profession it works, and the human-readable story of what it did.
--
-- Product invariant (mirrors the agent_mood "no change without a real signal"
-- rule): every agora_activity row CITES a real on-chain action or platform
-- event — a tx_signature, a task_pda, or a feed id. No fabricated citizens, no
-- fake trades. An empty economy renders an honest empty state. The currency is
-- $THREE; devnet plumbing may use native SOL or a synthetic placeholder mint,
-- never another real token.

-- ── Citizens ────────────────────────────────────────────────────────────────
-- One row per participant living in the world. Agent citizens are bridged to a
-- platform agent (agent_identities) and an on-chain AgenC agentId; human
-- citizens are signed-in users. The on-chain registry remains authoritative for
-- reputation/stake/status — the columns here are the last synced snapshot so the
-- world renders instantly without an RPC round-trip per frame.
create table if not exists agora_citizens (
    id              uuid primary key default gen_random_uuid(),
    -- 'agent' (autonomous, runs the daily loop) | 'human' (a signed-in person).
    kind            text not null check (kind in ('agent', 'human')),
    -- Agent citizens link to a real platform agent; humans link to a user id.
    agent_id        uuid references agent_identities(id) on delete cascade,
    user_id         text,

    display_name    text not null,
    -- Avatar GLB this citizen wears in the City (loose pointers — no FK so a
    -- citizen survives an avatar record's lifecycle).
    avatar_id       uuid,
    avatar_url      text,

    -- Canonical AgenC identity, derived via the identity bridge (erc8004 /
    -- mpl-core / handle / composite) — NOT a new namespace. Null until linked.
    agenc_agent_id  text,                 -- 32-byte canonical id, lowercase hex
    agenc_agent_pda text,                 -- derived on-chain account, base58
    agenc_cluster   text not null default 'devnet'
                        check (agenc_cluster in ('devnet', 'mainnet')),
    identity_source text,                 -- how the id was derived (provenance)

    -- Profession = the primary capability the citizen works; capability_bits is
    -- the full u64 AgenC bitmap (a citizen can hold several professions). Bit
    -- meanings are documented in docs/agora.md and never a hardcoded allowlist.
    profession      text,
    capability_bits bigint not null default 0,

    -- Live world state. status mirrors the daily-loop node the citizen is in.
    status          text not null default 'idle'
                        check (status in ('idle', 'seeking', 'busy', 'offline')),
    home_x          real not null default 0,
    home_z          real not null default 0,
    pos_x           real not null default 0,
    pos_z           real not null default 0,

    -- Last synced on-chain snapshot + cumulative world economy stats.
    reputation          integer not null default 0,
    stake_lamports      bigint  not null default 0,
    earned_three_atomic numeric not null default 0,   -- cumulative $THREE earned
    tasks_completed     integer not null default 0,
    tasks_posted        integer not null default 0,

    joined_at       timestamptz not null default now(),
    last_active_at  timestamptz not null default now(),
    synced_at       timestamptz,                       -- last on-chain reconcile
    meta            jsonb not null default '{}'::jsonb
);

-- One citizen per platform agent, and per human — enforced where the link is set.
create unique index if not exists agora_citizens_agent_uniq
    on agora_citizens(agent_id) where agent_id is not null;
create unique index if not exists agora_citizens_user_uniq
    on agora_citizens(user_id) where user_id is not null;
create unique index if not exists agora_citizens_agenc_pda_uniq
    on agora_citizens(agenc_agent_pda) where agenc_agent_pda is not null;
create index if not exists agora_citizens_status
    on agora_citizens(status, last_active_at desc);
create index if not exists agora_citizens_profession
    on agora_citizens(profession);

-- ── Activity ledger ──────────────────────────────────────────────────────────
-- Append-only story of what citizens do. Powers the activity feed, the economy
-- ticker, and the 3D narration from ONE source. Every row cites the real action
-- that produced it (tx_signature / task_pda / feed event).
create table if not exists agora_activity (
    id              uuid primary key default gen_random_uuid(),
    citizen_id      uuid not null references agora_citizens(id) on delete cascade,
    -- What happened. Each maps to a real on-chain instruction or platform event.
    kind            text not null check (kind in (
                        'registered',      -- joined AgenC (registerAgent)
                        'posted_task',     -- createTask (escrow locked)
                        'claimed_task',    -- claimTask
                        'completed_task',  -- completeTask (proof accepted)
                        'earned',          -- escrow released to this citizen
                        'hired',           -- posted a sub-task for another citizen
                        'paid_service',    -- x402 micro-payment to a service
                        'vouched',         -- left an attestation for a citizen
                        'slashed',         -- stake slashed on dispute
                        'moved'            -- changed districts (world-only)
                    )),

    task_pda        text,                  -- on-chain task account, base58
    task_id         text,                  -- 32-byte task id, hex
    profession      text,                  -- profession exercised, if any
    counterparty_citizen_id uuid references agora_citizens(id) on delete set null,

    amount_atomic   numeric,               -- reward/payment, atomic units
    reward_mint     text,                  -- '$THREE' | null (native SOL) | 'USDC'
    reward_label    text,                  -- human label, e.g. '25,000 $THREE'

    tx_signature    text,                  -- the on-chain proof of this action
    proof_hash      text,                  -- 32-byte completion proof, hex
    deliverable_url text,                  -- e.g. the forge GLB the worker produced

    -- Human-readable story line — the single narration the feed + world + ticker
    -- all render. Mandatory: an activity with no story isn't worth recording.
    narrative       text not null,
    rep_before      integer,
    rep_after       integer,
    world_x         real,
    world_z         real,

    created_at      timestamptz not null default now(),
    meta            jsonb not null default '{}'::jsonb
);

create index if not exists agora_activity_citizen_time
    on agora_activity(citizen_id, created_at desc);
create index if not exists agora_activity_kind_time
    on agora_activity(kind, created_at desc);
create index if not exists agora_activity_global_time
    on agora_activity(created_at desc);
create index if not exists agora_activity_task
    on agora_activity(task_pda) where task_pda is not null;

-- Idempotency: an on-chain action is projected at most once. A unique tx_signature
-- per (citizen, kind) lets the life-engine reconcile re-runs without double-count.
create unique index if not exists agora_activity_tx_uniq
    on agora_activity(citizen_id, kind, tx_signature)
    where tx_signature is not null;

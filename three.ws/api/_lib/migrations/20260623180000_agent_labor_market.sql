begin;

-- The Agent Labor Market (Moonshot 01) — a real, autonomous machine economy.
--
-- One agent posts a bounty (escrowing the reward in $THREE from its own custodial
-- wallet), other agents discover and bid on it, the poster (or its autonomous
-- policy) awards the best bid, the worker performs the task by invoking a licensed
-- skill, a neutral verifier scores the deliverable, and on a pass the escrow is
-- released ON-CHAIN to the worker's wallet with the skill royalty routed to the
-- author — recorded as a real agent-invocation receipt. No human in the loop.
--
-- Money columns are atomic-unit integers ($THREE has 6 decimals), stored as
-- numeric(40,0) so they are exact (never floats) AND summable for earnings rollups.
-- Escrow is REAL on-chain custody (agent_bounties.escrow_address / escrow_fund_sig),
-- not a DB flag: funds are actually held by the escrow wallet and actually released.

-- ── Bounties ────────────────────────────────────────────────────────────────
create table if not exists agent_bounties (
    id                 uuid primary key default gen_random_uuid(),

    -- The employer: an agent owned by the caller. poster_user_id is the ownership
    -- anchor enforced server-side on every mutation.
    poster_agent_id    uuid not null,
    poster_user_id     uuid not null,

    title              text not null,
    spec               text not null,          -- what the worker must produce
    required_skill     text,                   -- skill slug the worker must hold a license for

    -- Reward, escrowed in $THREE. reward_mint is always the $THREE mint (enforced
    -- in code); kept as a column so a hire stays auditable if config ever changes.
    reward_atomics     numeric(40,0) not null check (reward_atomics > 0),
    reward_mint        text not null,

    -- Lifecycle: open → awarded → working → verifying → settled
    --                                              \→ refunded | failed | cancelled
    status             text not null default 'open',
    deadline           timestamptz,

    -- Real on-chain escrow custody.
    escrow_address     text,                   -- wallet that holds the reward
    escrow_fund_sig    text,                   -- poster wallet → escrow funding tx
    refund_sig         text,                   -- escrow → poster refund tx (failure path)

    -- Award.
    awarded_bid_id     uuid,
    awarded_agent_id   uuid,
    awarded_at         timestamptz,
    award_rationale    text,                   -- transparent reason the bid won (algo + LLM)

    auto               boolean not null default false,  -- posted by an autonomous policy
    meta               jsonb not null default '{}',
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),

    constraint agent_bounties_status_chk
        check (status in ('open','awarded','working','verifying','settled','refunded','failed','cancelled'))
);

-- Open-bounty feed (the discovery surface): newest open bounties first.
create index if not exists agent_bounties_feed
    on agent_bounties (status, created_at desc);
-- Per-skill matching for the autonomy engine.
create index if not exists agent_bounties_skill_open
    on agent_bounties (required_skill)
    where status = 'open';
-- Per-poster history (the profile "Work" tab).
create index if not exists agent_bounties_poster
    on agent_bounties (poster_agent_id, created_at desc);

-- ── Bids ────────────────────────────────────────────────────────────────────
create table if not exists agent_bids (
    id              uuid primary key default gen_random_uuid(),
    bounty_id       uuid not null,
    worker_agent_id uuid not null,
    worker_user_id  uuid not null,

    price_atomics   numeric(40,0) not null check (price_atomics > 0),  -- $THREE the worker will accept
    eta_seconds     integer,                                           -- promised turnaround
    pitch           text,

    -- Transparent award score (price × eta × reputation) captured at award time,
    -- plus the human/LLM rationale that fed the reasoning ledger.
    score           double precision,
    rationale       text,
    reputation      double precision,

    auto            boolean not null default false,   -- placed by an autonomous policy
    status          text not null default 'pending',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    constraint agent_bids_status_chk check (status in ('pending','awarded','rejected','withdrawn')),
    -- One live bid per worker per bounty; a re-bid upserts.
    constraint agent_bids_unique_worker unique (bounty_id, worker_agent_id)
);

create index if not exists agent_bids_bounty on agent_bids (bounty_id, created_at desc);
create index if not exists agent_bids_worker on agent_bids (worker_agent_id, created_at desc);

-- ── Jobs (the awarded → settled work record) ────────────────────────────────
create table if not exists agent_jobs (
    id                     uuid primary key default gen_random_uuid(),
    bounty_id              uuid not null,
    bid_id                 uuid not null,
    worker_agent_id        uuid not null,
    worker_user_id         uuid not null,
    poster_agent_id        uuid not null,
    required_skill         text,
    price_atomics          numeric(40,0) not null,   -- the awarded reward ($THREE atomics)

    status                 text not null default 'working',
    deliverable            jsonb,
    delivered_at           timestamptz,

    -- Verification verdict { pass, score, reason, verifier }.
    verdict                jsonb,
    verified_at            timestamptz,

    -- Real on-chain artifacts.
    invocation_sig         text,                      -- agent-invocation invoke_skill receipt
    settlement_sig         text,                      -- escrow → worker payout tx
    royalty_sig            text,                      -- escrow → skill author royalty tx
    royalty_atomics        numeric(40,0),
    worker_payout_atomics  numeric(40,0),
    royalty_author_id      uuid,

    -- Idempotent settlement: a retry with the same key never double-pays.
    settle_key             text,
    settled_at             timestamptz,
    refund_sig             text,
    failure_reason         text,

    meta                   jsonb not null default '{}',
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),

    constraint agent_jobs_status_chk
        check (status in ('working','delivered','verifying','settled','refunded','failed')),
    -- One job per bounty (a bounty is awarded once).
    constraint agent_jobs_bounty_unique unique (bounty_id)
);

create index if not exists agent_jobs_worker on agent_jobs (worker_agent_id, status);
create index if not exists agent_jobs_poster on agent_jobs (poster_agent_id, created_at desc);
-- Settlement idempotency guard.
create unique index if not exists agent_jobs_settle_key
    on agent_jobs (settle_key) where settle_key is not null;
-- Recent-settlement ticker (the live $THREE flow feed).
create index if not exists agent_jobs_settled_at
    on agent_jobs (settled_at desc) where status = 'settled';

-- ── Per-agent labor autonomy policy (opt-in) ────────────────────────────────
create table if not exists agent_labor_policies (
    agent_id           uuid primary key,
    user_id            uuid not null,

    -- Worker side: auto-bid on matching bounties within these limits.
    worker_enabled     boolean not null default false,
    skills             text[] not null default '{}',     -- skills this agent will work for hire
    max_bid_atomics    numeric(40,0),                     -- never bid above this
    min_reward_atomics numeric(40,0),                     -- ignore bounties cheaper than this

    -- Poster side: auto-award the best bid by the transparent score.
    poster_enabled     boolean not null default false,
    auto_award         boolean not null default false,
    min_bids           integer not null default 1,        -- wait for at least this many bids

    meta               jsonb not null default '{}',
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

create index if not exists agent_labor_policies_worker
    on agent_labor_policies (worker_enabled) where worker_enabled = true;

commit;

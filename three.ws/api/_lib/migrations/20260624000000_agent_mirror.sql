-- Migration: custodial mirror / copy-trade social graph (task 09).
--
-- Distinct from the NON-custodial copy_subscriptions/copy_executions system
-- (api/copy/*, api/cron/copy-fanout.js), which only records INTENTS the copier
-- acts on from their own wallet. This layer is CUSTODIAL: a follower agent's own
-- server-signed wallet auto-mirrors a leader agent's real on-chain trades through
-- the same task-05 trade engine + the same shared spend guardrails
-- (api/_lib/agent-trade-guards.js). Every mirrored trade is a real tx within real
-- limits, fully audited in agent_custody_events (category 'trade', reason
-- 'mirror'), and the owner can pause one edge or kill all mirroring at once.
--
-- apply-migrations.mjs only runs api/_lib/migrations/*.sql, so the schema lives
-- here. Everything is `if not exists`, safe to re-apply.
begin;

-- ── agent_mirror_follows — the directed copy-trade graph ─────────────────────
-- One row = "follower_agent_id mirrors leader_agent_id, under owner_user_id's
-- spend policy." Owner-only to create/edit (owner_user_id is the follower's
-- owner, snapshotted for the cron's authz + audit). `enabled` pauses one edge;
-- the agent-wide kill switch lives at agent_identities.meta.mirror_killed and
-- halts every edge for the follower at once. last_leader_event_id is the cursor
-- into agent_custody_events.id so the fanout never reprocesses an old trade.
create table if not exists agent_mirror_follows (
    id                   bigserial   primary key,
    follower_agent_id    uuid        not null references agent_identities(id) on delete cascade,
    leader_agent_id      uuid        not null references agent_identities(id) on delete cascade,
    owner_user_id        uuid        not null references users(id) on delete cascade,
    network              text        not null default 'mainnet',
    enabled              boolean     not null default true,

    -- Sizing rule: how a leader buy of N SOL becomes the follower's order.
    --   'fixed'         → always order fixed_sol
    --   'proportional'  → leader_sol * (proportion_pct / 100)
    --   'pct_balance'   → follower_spendable_sol * (pct_balance / 100)
    sizing_mode          text        not null default 'proportional',
    fixed_sol            double precision,
    proportion_pct       double precision default 100,
    pct_balance          double precision,

    -- Per-follow leash. max_per_trade_sol hard-caps any single mirrored buy;
    -- daily_budget_sol is an optional extra ceiling on top of the follower's
    -- agent-level trade_limits (null = governed solely by the agent policy).
    max_per_trade_sol    double precision,
    daily_budget_sol     double precision,
    min_leader_sol       double precision default 0,   -- ignore leader buys smaller than this

    copy_sells           boolean     not null default true,
    mint_allowlist       text[]      not null default '{}'::text[],  -- if non-empty, only mirror these mints
    mint_denylist        text[]      not null default '{}'::text[],  -- never mirror these mints

    last_leader_event_id bigint      not null default 0,
    paused_reason        text,        -- set when auto-paused (e.g. repeated failures)
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),

    check (follower_agent_id <> leader_agent_id)
);

-- One follow edge per (follower, leader). The toggle/upsert keys on this.
create unique index if not exists agent_mirror_follows_edge
    on agent_mirror_follows (follower_agent_id, leader_agent_id);

-- Hot read: "who does this agent follow" (owner management view).
create index if not exists agent_mirror_follows_by_follower
    on agent_mirror_follows (follower_agent_id, created_at desc);

-- Hot read: "who follows this agent" (leader's follower count + discovery).
create index if not exists agent_mirror_follows_by_leader
    on agent_mirror_follows (leader_agent_id);

-- Fanout scan: active edges per leader+network whose cursor may be behind.
create index if not exists agent_mirror_follows_active
    on agent_mirror_follows (leader_agent_id, network)
    where enabled = true;

comment on table agent_mirror_follows is
    'Custodial copy-trade graph: follower_agent_id auto-mirrors leader_agent_id''s '
    'real trades through the task-05 engine, within the follower owner''s spend policy.';

-- ── agent_mirror_fills — the per-mirror execution log ────────────────────────
-- One row per (follow, leader trade) the fanout considered: executed, skipped
-- (with a human reason), failed, or unconfirmed. The unique key makes mirroring
-- idempotent — a leader trade can never be mirrored twice for the same follow.
-- custody_event_id links to the real agent_custody_events row (signature, USD,
-- audit) that the trade engine wrote; this table is the social/track-record view.
create table if not exists agent_mirror_fills (
    id                bigserial    primary key,
    follow_id         bigint       not null references agent_mirror_follows(id) on delete cascade,
    follower_agent_id uuid         not null,
    leader_agent_id   uuid         not null,
    owner_user_id     uuid,
    network           text         not null default 'mainnet',

    leader_event_id   bigint       not null,   -- agent_custody_events.id of the leader trade
    leader_signature  text,
    side              text         not null,    -- 'buy' | 'sell'
    mint              text         not null,
    leader_sol        double precision,         -- leader's SOL leg size
    planned_sol       double precision,         -- sized for the follower (buys)

    status            text         not null,    -- 'executed' | 'skipped' | 'failed' | 'unconfirmed'
    skip_reason       text,
    custody_event_id  bigint,                   -- follower's agent_custody_events row
    signature         text,
    usd               double precision,
    price_impact_pct  double precision,
    created_at        timestamptz  not null default now()
);

-- Idempotency: one mirror outcome per (follow, leader trade, side).
create unique index if not exists agent_mirror_fills_idem
    on agent_mirror_fills (follow_id, leader_event_id, side);

-- Owner feed: this follower's recent mirror activity, newest first.
create index if not exists agent_mirror_fills_by_follower
    on agent_mirror_fills (follower_agent_id, created_at desc);

-- Leader view: trades this leader generated for its followers.
create index if not exists agent_mirror_fills_by_leader
    on agent_mirror_fills (leader_agent_id, created_at desc);

comment on table agent_mirror_fills is
    'Per-mirror execution log linking a leader trade to the follower''s real fill '
    '(or the reason it was skipped). Unique (follow,leader_event,side) = no double-mirror.';

commit;

begin;

-- Fork Royalty Streams — provenance income for avatar creators
-- ============================================================
-- A fork on three.ws is already a brand-new agent with a brand-new custodial
-- wallet owned solely by the forker; no secret is ever copied and the original
-- owner can never touch the fork's funds. Fork royalties NEVER change that. They
-- are an OPT-IN, creator-configured revenue split on the FORK'S OWN new income —
-- a defined slice of value at the moment it is earned, shared upstream by prior
-- agreement (like a sample clearance), executed as a real on-chain transfer FROM
-- the fork's wallet TO its ancestors. The forker keeps the clear majority; the
-- total upstream take is hard-capped and decays with lineage distance so deep
-- chains can never become extractive.
--
-- The royalty RATE a creator sets lives on agent_identities.meta.fork_royalty
-- (config, owner-only, applies to FUTURE forks only). These two tables hold the
-- immutable per-fork CONSENT SNAPSHOT and the real PAYOUT LEDGER.

-- ── Per-fork consent snapshot (immutable) ──────────────────────────────────────
-- Written once, at fork time, by api/avatars/fork.js after the forker has been
-- shown and accepted the terms. It freezes the resolved upstream schedule — each
-- ancestor's royalty rate AS IT WAS at the moment of forking — so a later change
-- to an ancestor's rate can never retroactively tax an existing fork. `schedule`
-- is the source of truth the payout engine reads; `total_bps` is the capped sum
-- (<= ROYALTY_TOTAL_CAP_BPS) and the forker always keeps 10000 - total_bps.
create table if not exists fork_royalty_terms (
    id              uuid         primary key default gen_random_uuid(),
    fork_agent_id   uuid         not null unique references agent_identities(id) on delete cascade,
    fork_avatar_id  uuid,
    total_bps       integer      not null default 0 check (total_bps >= 0 and total_bps <= 10000),
    -- [{ depth, ancestor_agent_id, ancestor_avatar_id, ancestor_owner_id,
    --    ancestor_owner_name, ancestor_wallet, set_bps, bps, eligible:{tips,stream} }]
    -- depth 1 = the immediate parent. bps is the decayed+capped effective rate;
    -- set_bps is what that ancestor had configured at fork time (for the receipt).
    schedule        jsonb        not null default '[]'::jsonb,
    accepted_by     uuid,                                  -- the forker (user_id) who consented
    created_at      timestamptz  not null default now()
);

create index if not exists fork_royalty_terms_agent
    on fork_royalty_terms (fork_agent_id);

-- ── Real payout ledger (one row per ancestor per income event) ──────────────────
-- Every eligible income event on a fork (a SOL tip or SOL money-stream
-- settlement that credited the fork's wallet) fans out into one ledger row per
-- upstream ancestor. The row is the single source of truth for the transparent
-- split view both sides see. Idempotency is the (source_event_id, ancestor_agent_id)
-- unique key: a retry of the same income event never pays an ancestor twice.
--
--   status:  pending   — row claimed, transfer not yet confirmed
--            confirmed — real on-chain transfer landed (signature set)
--            failed    — transfer attempt failed; safe to retry (no funds moved)
--            skipped   — share below dust floor; nothing owed (honest zero)
--   rerouted: the lineage ancestor was deleted / had no wallet, so its share was
--             routed per the disclosed rule (to the platform treasury). reason
--             records why; recipient_wallet is where the SOL actually went.
create table if not exists fork_royalty_payouts (
    id                  uuid        primary key default gen_random_uuid(),
    fork_agent_id       uuid        not null references agent_identities(id) on delete cascade,
    ancestor_agent_id   uuid        not null,             -- the lineage ancestor (stable; from the snapshot)
    recipient_wallet    text,                             -- wallet actually paid (ancestor, or treasury if rerouted)
    depth               integer     not null default 1,
    bps                 integer     not null default 0,
    source_event_id     bigint      not null,             -- agent_custody_events.id that triggered this
    source_kind         text        not null,             -- 'tip' | 'stream'
    network             text        not null default 'mainnet',
    asset               text        not null default 'SOL',
    amount_lamports     bigint,
    usd                 numeric,
    status              text        not null default 'pending',
    signature           text,
    rerouted            boolean     not null default false,
    reason              text,
    meta                jsonb       not null default '{}'::jsonb,
    created_at          timestamptz not null default now(),
    confirmed_at        timestamptz
);

-- Idempotency: exactly one royalty obligation per (income event, ancestor).
create unique index if not exists fork_royalty_payouts_idem
    on fork_royalty_payouts (source_event_id, ancestor_agent_id);

-- Descendant view ("what this fork has paid upstream"), newest first.
create index if not exists fork_royalty_payouts_fork
    on fork_royalty_payouts (fork_agent_id, created_at desc);

-- Ancestor view ("royalty income by descendant"), newest first.
create index if not exists fork_royalty_payouts_ancestor
    on fork_royalty_payouts (ancestor_agent_id, created_at desc)
    where status in ('pending', 'confirmed');

comment on table fork_royalty_terms is
    'Immutable per-fork consent snapshot of the upstream royalty schedule, frozen '
    'at fork time so an ancestor''s later rate change never retroactively taxes an '
    'existing fork. Read by the payout engine in api/_lib/fork-royalties.js. The '
    'configurable RATE lives on agent_identities.meta.fork_royalty.';
comment on table fork_royalty_payouts is
    'Real on-chain royalty split ledger: one row per ancestor per eligible income '
    'event on a fork. Idempotent on (source_event_id, ancestor_agent_id) — no '
    'double-pay on retry. Backs the transparent split view both forker and '
    'ancestor see; every confirmed row links to a real tx signature.';

commit;

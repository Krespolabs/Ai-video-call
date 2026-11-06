begin;

-- Agent-to-Agent Economy (prompts/agent-wallets/15) — the real hire ledger.
--
-- Every time one agent hires another for a paid skill over the real x402 rails
-- (api/agents/a2a-hire.js), exactly one row is written here. It is the single
-- source of truth for: the marketplace's REAL completion counts / ratings /
-- throughput (no fabricated stats), both wallets' income/outlay accounting, and
-- the link from a hire to its real on-chain artifacts (the USDC settlement tx and
-- the agent-invocation receipt tx). Money movement itself is enforced upstream by
-- the spend policy (agent_custody_events reservation) and the x402 spending cap;
-- this table records the business-level hire and its lifecycle.

create table if not exists agent_hires (
    id                    uuid primary key default gen_random_uuid(),

    -- Who hired (the paying side) and who provided (the earning side).
    hirer_agent_id        uuid not null,
    hirer_user_id         uuid not null,
    provider_agent_id     uuid,
    provider_user_id      uuid,

    -- The offer that was hired. service_id references the existing offer registry
    -- (agent_paid_services); slug/skill kept denormalized so a hire stays readable
    -- even if the offer is later archived.
    service_id            uuid,
    service_slug          text,
    skill_name            text not null,

    -- Price + rail. amount_atomics is USDC 6-decimal atomic units (string to avoid
    -- float drift); usd is the human dollar value for the feed/accounting.
    amount_atomics        text not null,
    usd                   double precision,
    currency              text not null default 'USDC',
    network               text not null default 'solana',

    -- Lifecycle: pending → completed | refunded | failed | disputed.
    status                text not null default 'pending',

    -- Real on-chain artifacts (explorer links derived from these).
    payment_signature     text,   -- USDC settlement tx (hirer wallet → provider wallet)
    invocation_signature  text,   -- agent-invocation invoke_skill receipt tx
    invocation_error      text,   -- recorded if the receipt write failed (payment still real)
    payer_address         text,   -- hirer wallet that paid
    payout_address        text,   -- provider wallet that earned

    -- Spend-policy reservation row id (agent_custody_events) so the hire can be
    -- finalized/released atomically, and the audit trail joins up.
    spend_reservation_id  bigint,

    -- Idempotency: a retried hire with the same key never double-charges.
    idempotency_key       text,

    -- Result + quality.
    result_summary        text,
    error                 text,
    rating                smallint,  -- 1..5, set by the hirer after a completed hire
    rated_at              timestamptz,

    meta                  jsonb not null default '{}',
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    completed_at          timestamptz,

    constraint agent_hires_status_chk
        check (status in ('pending', 'completed', 'refunded', 'failed', 'disputed')),
    constraint agent_hires_rating_chk
        check (rating is null or (rating between 1 and 5))
);

-- One row per (hirer agent, idempotency key) — the double-charge guard. A retry
-- conflicts here and returns the existing hire instead of paying again.
create unique index if not exists agent_hires_idem
    on agent_hires (hirer_agent_id, idempotency_key)
    where idempotency_key is not null;

-- Provider reputation + earnings: count/sum/avg-rating over a provider's hires.
create index if not exists agent_hires_provider_time
    on agent_hires (provider_agent_id, created_at desc);

-- Hirer accounting (outlay feed).
create index if not exists agent_hires_hirer_time
    on agent_hires (hirer_agent_id, created_at desc);

-- Marketplace stats roll-ups scan completed hires per service.
create index if not exists agent_hires_service_status
    on agent_hires (service_id, status);

commit;

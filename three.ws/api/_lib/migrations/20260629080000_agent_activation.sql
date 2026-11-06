-- Agent activation grants — the onboarding "Go Live" welcome grant.
--
-- When a real owner activates their agent, the platform treasury sends a small,
-- one-time, on-chain SOL grant to the agent's custodial wallet. That transfer is
-- recorded as a real `tip` custody event (api/_lib/activation.js), so the agent
-- instantly appears on the Money Pulse as an active, funded wallet — solving the
-- cold-start dead-end where a fresh agent sits at ◎0 and can never make its first
-- transaction.
--
-- This table is the idempotency + anti-sybil ledger: exactly one grant per agent
-- (agent_id primary key), with a status mutex so concurrent activation POSTs can
-- never double-spend. The engine also creates it lazily, so this migration is
-- belt-and-suspenders (matches the circulation_actions pattern).

create table if not exists agent_activations (
    agent_id     uuid primary key,
    user_id      uuid,
    network      text        not null default 'mainnet',
    status       text        not null default 'pending', -- pending | confirmed
    signature    text,
    lamports     bigint,
    usd          numeric,
    created_at   timestamptz not null default now(),
    confirmed_at timestamptz
);

-- Daily-cap query counts confirmed grants in a rolling window.
create index if not exists agent_activations_confirmed
    on agent_activations (created_at desc)
    where status = 'confirmed';

-- Activity ledger for the autonomous agent engine (api/_lib/circulation.js).
-- Records every action a platform-operated agent takes (tips, payments, trades,
-- launches, on-chain deploys, reviews, funding top-ups) for pacing + observability.
-- The engine also creates this table lazily, so this migration is belt-and-suspenders.

create table if not exists circulation_actions (
    id                    bigserial primary key,
    kind                  text not null,
    network               text,
    actor_agent_id        uuid,
    counterparty_agent_id uuid,
    signature             text,
    amount_lamports       bigint,
    status                text not null default 'ok',
    detail                jsonb not null default '{}'::jsonb,
    created_at            timestamptz not null default now()
);

create index if not exists circulation_actions_created on circulation_actions(created_at desc);
create index if not exists circulation_actions_kind on circulation_actions(kind, created_at desc);

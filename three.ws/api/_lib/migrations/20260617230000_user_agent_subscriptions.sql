-- User subscriptions to agent skill tiers: a user pays a recurring fee for
-- access to all of an agent's paid skills. Different from agent_subscriptions
-- (DCA/on-chain payment schedules) — this is the skill-access gate.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260617230000_user_agent_subscriptions.sql
-- Idempotent.

begin;

-- Subscription pricing configured by the creator on their agent.
alter table agent_identities
    add column if not exists subscription_amount    bigint,
    add column if not exists subscription_interval  text default 'month',
    add column if not exists subscription_currency_mint text;

-- Per-user active subscriptions to an agent.
create table if not exists user_agent_subscriptions (
    id                      uuid primary key default gen_random_uuid(),
    user_id                 uuid not null references users(id) on delete cascade,
    agent_id                uuid not null references agent_identities(id) on delete cascade,
    status                  text not null default 'active'
                            check (status in ('active', 'cancelled', 'past_due', 'expired')),
    current_period_ends_at  timestamptz not null,
    tx_signature            text,
    price_amount            bigint not null,
    currency_mint           text not null,
    chain                   text not null default 'solana',
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    cancelled_at            timestamptz,
    unique (user_id, agent_id)
);

create index if not exists idx_user_agent_subs_user on user_agent_subscriptions(user_id);
create index if not exists idx_user_agent_subs_agent on user_agent_subscriptions(agent_id);
create index if not exists idx_user_agent_subs_active
    on user_agent_subscriptions(user_id, agent_id)
    where status = 'active';

commit;

-- Dynamic pricing rules: creators can define rules that automatically adjust
-- the price of a skill based on demand or time.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260617220000_skill_pricing_rules.sql
-- Idempotent.

begin;

-- Rules are evaluated in ascending priority order. First matching rule wins.
create table if not exists skill_pricing_rules (
    id              uuid primary key default gen_random_uuid(),
    agent_id        uuid not null references agent_identities(id) on delete cascade,
    skill_name      text not null,
    rule_type       text not null
                    check (rule_type in ('first_n_purchases', 'after_n_purchases', 'time_window')),
    -- For first_n_purchases: discount price for first N buyers (threshold = N).
    -- For after_n_purchases: price increases after N total sales.
    -- For time_window: discount only applies between start_at and end_at.
    threshold       integer,            -- first_n / after_n count
    price_amount    bigint not null,    -- price in currency atomic units when rule applies
    currency_mint   text not null,
    chain           text not null default 'solana',
    start_at        timestamptz,        -- time_window: rule active from
    end_at          timestamptz,        -- time_window: rule active until
    priority        integer not null default 0,
    is_active       boolean not null default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists idx_pricing_rules_skill
    on skill_pricing_rules(agent_id, skill_name)
    where is_active;

commit;

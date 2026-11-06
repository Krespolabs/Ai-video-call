-- Skill bundles: creators can sell multiple skills together at a single price.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260617200000_skill_bundles.sql
-- Idempotent.

begin;

-- Bundle header — one per creator-defined bundle.
create table if not exists skill_bundles (
    id              uuid primary key default gen_random_uuid(),
    agent_id        uuid not null references agent_identities(id) on delete cascade,
    name            text not null,
    description     text,
    price_amount    bigint not null check (price_amount > 0),
    currency_mint   text not null,
    chain           text not null default 'solana',
    is_active       boolean not null default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists idx_skill_bundles_agent on skill_bundles(agent_id) where is_active;

-- Bundle items — which skills belong to which bundle.
create table if not exists bundle_items (
    id          uuid primary key default gen_random_uuid(),
    bundle_id   uuid not null references skill_bundles(id) on delete cascade,
    skill_name  text not null,
    created_at  timestamptz not null default now(),
    unique (bundle_id, skill_name)
);

create index if not exists idx_bundle_items_bundle on bundle_items(bundle_id);

-- Purchase records for bundle purchases (separate from single-skill purchases).
create table if not exists bundle_purchases (
    id                  uuid primary key default gen_random_uuid(),
    bundle_id           uuid not null references skill_bundles(id) on delete restrict,
    user_id             uuid not null references users(id) on delete cascade,
    agent_id            uuid not null,
    price_amount        bigint not null,
    currency_mint       text not null,
    chain               text not null default 'solana',
    tx_signature        text,
    status              text not null default 'pending'
                        check (status in ('pending', 'confirmed', 'failed', 'refunded')),
    platform_fee_amount bigint not null default 0,
    created_at          timestamptz not null default now(),
    confirmed_at        timestamptz
);

create index if not exists idx_bundle_purchases_user on bundle_purchases(user_id);
create index if not exists idx_bundle_purchases_bundle on bundle_purchases(bundle_id);
create unique index if not exists idx_bundle_purchases_tx on bundle_purchases(tx_signature)
    where tx_signature is not null;

commit;

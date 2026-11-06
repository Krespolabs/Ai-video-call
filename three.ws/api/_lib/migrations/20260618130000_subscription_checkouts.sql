-- Pending on-chain checkouts for the user→agent subscription flow.
--
-- When a user subscribes to an agent tier, the server quotes an exact USDC
-- split (creator leg + platform fee leg), mints a Solana-Pay reference, and
-- builds a transaction the buyer signs. That quote must be persisted server-side
-- so /api/subscriptions/verify validates the SAME amounts the buyer signed —
-- the client is never trusted for the price or the recipient. This mirrors the
-- role skill_purchases plays for one-off skill unlocks.
--
-- The row advances pending → confirmed (or failed/expired) exactly once; the
-- activated subscription lands in creator_subscriptions + user_agent_subscriptions.
--
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260618130000_subscription_checkouts.sql
-- Idempotent.

begin;

create table if not exists subscription_checkouts (
    id                  uuid        primary key default gen_random_uuid(),
    reference           text        not null unique,        -- base58 Solana-Pay reference pubkey
    user_id             uuid        not null references users(id) on delete cascade,
    plan_id             uuid        not null references subscription_plans(id) on delete cascade,
    agent_id            uuid        references agent_identities(id) on delete set null,
    status              text        not null default 'pending'
                                    check (status in ('pending', 'confirmed', 'failed', 'expired')),
    amount              bigint      not null,               -- gross atomics the buyer pays
    creator_amount      bigint      not null,               -- seller leg (gross − fee)
    platform_fee_amount bigint      not null default 0,
    platform_fee_wallet text,
    currency_mint       text        not null,
    chain               text        not null default 'solana',
    recipient           text        not null,               -- creator payout address
    buyer_public_key    text,
    interval            text        not null,               -- 'weekly' | 'monthly' (from the plan)
    tx_signature        text,
    expires_at          timestamptz not null,
    confirmed_at        timestamptz,
    created_at          timestamptz not null default now()
);

-- One live pending checkout per (user, plan): the subscribe endpoint reuses a
-- fresh pending row on retry instead of minting a new reference each click.
create unique index if not exists subscription_checkouts_pending_uq
    on subscription_checkouts(user_id, plan_id)
    where status = 'pending';

create index if not exists subscription_checkouts_user_idx
    on subscription_checkouts(user_id);

commit;

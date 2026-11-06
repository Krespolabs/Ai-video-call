-- Migration: syndicates, named groups of copiers who follow the same leader(s).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260929120000_copy_syndicates.sql
-- Idempotent.
--
-- A syndicate is a team on top of the existing copy loop, not a new money path.
-- Joining one creates ordinary copy_subscriptions rows through the same guarded
-- subscribe path /api/copy/subscriptions uses (self-copy refusal, the copyable
-- bar, the member's own sizing, per-trade cap, daily budget and drawdown
-- breaker), so the fanout cron, the intents on /dashboard/copy and the HWM
-- performance fee all work unchanged. No member funds are pooled: every member
-- keeps their own wallet and their own caps, and leaving stops only the
-- subscriptions the join itself created.
--
-- Group performance is read live from copy_executions (the members' real copy
-- intents inside their membership window), priced exactly the way
-- api/_lib/copy-earnings.js prices a copier's realized profit. Nothing here
-- stores a performance number. api/_lib/syndicates.js owns reads and writes.

begin;

create table if not exists copy_syndicates (
    id               uuid primary key default gen_random_uuid(),
    slug             text not null unique,
    name             text not null,
    motto            text,
    color            text not null default '#7c5cff',
    network          text not null default 'mainnet' check (network in ('mainnet','devnet')),
    founder_user_id  uuid not null references users(id) on delete cascade,
    status           text not null default 'active' check (status in ('active','archived')),
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    constraint copy_syndicates_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
    constraint copy_syndicates_name_len check (char_length(name) between 3 and 40),
    constraint copy_syndicates_motto_len check (motto is null or char_length(motto) <= 140),
    constraint copy_syndicates_color_hex check (color ~ '^#[0-9a-f]{6}$')
);

-- Two syndicates may not share a name on a network, whatever the casing.
create unique index if not exists copy_syndicates_name_uniq
    on copy_syndicates (network, lower(name));
create index if not exists copy_syndicates_board
    on copy_syndicates (network, status, created_at desc);
create index if not exists copy_syndicates_founder
    on copy_syndicates (founder_user_id, network, status);

-- The leader(s) a syndicate follows: one to three agents, fixed at founding.
create table if not exists copy_syndicate_leaders (
    syndicate_id     uuid not null references copy_syndicates(id) on delete cascade,
    leader_agent_id  uuid not null references agent_identities(id) on delete cascade,
    position         smallint not null default 0,
    primary key (syndicate_id, leader_agent_id)
);
create index if not exists copy_syndicate_leaders_agent
    on copy_syndicate_leaders (leader_agent_id);

create table if not exists copy_syndicate_members (
    id            uuid primary key default gen_random_uuid(),
    syndicate_id  uuid not null references copy_syndicates(id) on delete cascade,
    user_id       uuid not null references users(id) on delete cascade,
    network       text not null default 'mainnet' check (network in ('mainnet','devnet')),
    role          text not null default 'member' check (role in ('founder','member')),
    status        text not null default 'active' check (status in ('active','left')),
    joined_at     timestamptz not null default now(),
    left_at       timestamptz
);

-- One team per copier per network. A syndicate is an identity ("whose side are
-- you on"), and two memberships would also make the group curves double-count
-- the same copy intents.
create unique index if not exists copy_syndicate_members_one_team
    on copy_syndicate_members (user_id, network)
    where status = 'active';
create index if not exists copy_syndicate_members_roster
    on copy_syndicate_members (syndicate_id, status, joined_at);

-- Which copy subscriptions a membership rides on. created_by_join records
-- whether the join created the subscription (leaving stops it) or found the
-- member already copying that leader (leaving leaves it exactly as it was).
create table if not exists copy_syndicate_member_subs (
    member_id        uuid not null references copy_syndicate_members(id) on delete cascade,
    subscription_id  uuid not null references copy_subscriptions(id) on delete cascade,
    created_by_join  boolean not null default true,
    primary key (member_id, subscription_id)
);
create index if not exists copy_syndicate_member_subs_sub
    on copy_syndicate_member_subs (subscription_id);

comment on table copy_syndicates is
    'Named groups of copiers following the same leader(s). Membership rides on ordinary copy_subscriptions; no funds are pooled.';
comment on column copy_syndicate_member_subs.created_by_join is
    'true when joining created the subscription (leaving stops it); false when the member already copied that leader (leaving keeps it).';

commit;

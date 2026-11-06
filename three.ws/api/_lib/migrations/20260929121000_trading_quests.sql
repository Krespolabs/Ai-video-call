-- Migration: daily trading quests on top of streaks + badges.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260929121000_trading_quests.sql
-- Idempotent.
--
-- Quest progress is computed from events that already prove themselves
-- (copy_executions, agent_sniper_positions, agent_custody_events,
-- pump_agent_trades). Two kinds of event had no durable record, so they get one
-- here in trading_quest_events:
--
--   trade       a user-signed pump.fun trade whose signature buy-confirm /
--               sell-confirm verified on-chain. pump_agent_trades only keeps
--               coins launched on three.ws, so a trade of any other coin (most
--               forks) left no trace. One row per signature, first claim wins,
--               and origin = 'fork' when the trade panel was opened by a Fork.
--   ghost_copy  the first time a signed-in user ghost-copied a given leader.
--               The replay is stateless, so this row is its only trace; one per
--               (user, leader, network), which is exactly "a new agent".
--
-- trading_quest_completions is the award ledger (XP is its sum). Rows are only
-- ever inserted, so XP never goes down when an underlying row later changes.
--
-- trading_quest_three_rewards is the $THREE payout ledger for a daily clear. It
-- ships DISARMED: api/_lib/quest-rewards.js writes nothing here and moves
-- nothing on-chain unless TRADING_QUEST_THREE_REWARDS is armed (owner gate).

begin;

create table if not exists trading_quest_events (
    id          bigserial primary key,
    user_id     uuid not null references users(id) on delete cascade,
    kind        text not null check (kind in ('trade','ghost_copy')),
    ref         text not null,                               -- trade: tx signature; ghost_copy: leader agent id
    network     text not null default 'mainnet' check (network in ('mainnet','devnet')),
    origin      text check (origin is null or origin in ('fork')),
    wallet      text,                                        -- trade: the signing wallet
    context     jsonb,
    created_at  timestamptz not null default now()
);

-- A signature is one trade, whoever reports it first.
create unique index if not exists trading_quest_events_trade_uniq
    on trading_quest_events (ref, network)
    where kind = 'trade';
-- The first ghost of a leader wins, so created_at is "when this agent was new to you".
create unique index if not exists trading_quest_events_ghost_uniq
    on trading_quest_events (user_id, ref, network)
    where kind = 'ghost_copy';
create index if not exists trading_quest_events_user_day
    on trading_quest_events (user_id, kind, created_at desc);

create table if not exists trading_quest_completions (
    user_id       uuid not null references users(id) on delete cascade,
    day           date not null,                             -- UTC day the quest was completed for
    code          text not null,                             -- quest code, or 'daily_clear'
    xp            integer not null check (xp >= 0),
    completed_at  timestamptz not null default now(),
    primary key (user_id, day, code)
);
create index if not exists trading_quest_completions_user
    on trading_quest_completions (user_id, day desc);

create table if not exists trading_quest_three_rewards (
    user_id        uuid not null references users(id) on delete cascade,
    day            date not null,
    amount_atomic  numeric not null check (amount_atomic > 0),
    wallet         text not null,
    status         text not null default 'pending' check (status in ('pending','sent','failed')),
    tx_signature   text,
    error          text,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    primary key (user_id, day)
);
create index if not exists trading_quest_three_rewards_day
    on trading_quest_three_rewards (day, status);

comment on table trading_quest_events is
    'Proof rows for quest events with no other durable trace: verified user-signed trades and first ghost-copies per leader.';
comment on table trading_quest_three_rewards is
    'Daily-clear $THREE payouts. Empty unless TRADING_QUEST_THREE_REWARDS is armed by the owner.';

commit;

-- Migration: historical strategy backtest snapshots.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260625160000_strategy_backtests.sql
-- Idempotent.
--
-- Every run of POST /api/sniper/backtest replays a compiled sniper strategy over
-- the real captured universe (pump_coin_intel ⋈ pump_coin_outcomes) and writes
-- ONE row here: the projected win-rate / ROI distribution / drawdown for that
-- exact strategy + window, hashed for cache reuse. When a strategy is armed from
-- the builder, its snapshot is linked to the agent (agent_id), so the trader
-- profile can show projected-vs-realized side by side once it starts trading —
-- the projection stays accountable, not marketing. Read-only over real history;
-- no synthetic data is ever stored here.

begin;

create table if not exists strategy_backtests (
    id              uuid primary key default gen_random_uuid(),
    strategy_hash   text not null,                         -- hash of trade-determining fields + window + network
    agent_id        uuid references agent_identities(id) on delete cascade,  -- set when linked to an armed strategy
    user_id         uuid references users(id) on delete set null,
    network         text not null default 'mainnet' check (network in ('mainnet','devnet')),
    window_days     int not null,
    metrics         jsonb not null default '{}'::jsonb,    -- full result payload (win_rate, roi distribution, drawdown, samples, caveats)
    sample_size     int not null default 0,
    ran_at          timestamptz not null default now()
);

-- Cache lookup: freshest snapshot for a strategy hash.
create index if not exists strategy_backtests_hash
    on strategy_backtests (strategy_hash, ran_at desc);
-- Projected-vs-realized: freshest snapshot linked to an agent.
create index if not exists strategy_backtests_agent
    on strategy_backtests (agent_id, network, ran_at desc)
    where agent_id is not null;

commit;

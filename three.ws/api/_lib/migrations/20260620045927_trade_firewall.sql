-- Migration: Rug/Honeypot Simulation Firewall — pre-trade safety verdicts.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260620045927_trade_firewall.sql
-- Idempotent.
--
-- The trade firewall (api/_lib/trade-firewall.js) runs a real on-chain authority
-- audit + simulated buy→sell round-trip before EVERY buy path (sniper worker, the
-- two discretionary endpoints, and the public read-only API). This migration adds:
--
--   1. agent_sniper_strategies.firewall_level — per-strategy enforcement mode.
--      'block' (default): a 'block' verdict aborts the snipe.
--      'warn':  the verdict is recorded but the snipe proceeds (raw speed).
--      'off':   the firewall is skipped entirely for this strategy.
--
--   2. firewall_decisions — an append-only audit table of every verdict the
--      firewall returned (block/warn/allow), so blocks are observable and the
--      check thresholds can be tuned against real outcomes over time.

begin;

-- ── per-strategy enforcement mode ────────────────────────────────────────────
alter table agent_sniper_strategies
    add column if not exists firewall_level text not null default 'block'
        check (firewall_level in ('block', 'warn', 'off'));

-- ── verdict audit trail ──────────────────────────────────────────────────────
create table if not exists firewall_decisions (
    id          bigint generated always as identity primary key,
    mint        text not null,
    network     text not null default 'mainnet' check (network in ('mainnet', 'devnet')),
    side        text not null default 'buy' check (side in ('buy', 'sell')),
    -- the firewall's composed decision + 0..100 safety score
    verdict     text not null check (verdict in ('allow', 'warn', 'block')),
    score       int  not null default 0 check (score >= 0 and score <= 100),
    -- whether a real RPC round-trip simulation actually ran (vs. honest degrade)
    simulated   boolean not null default false,
    -- full per-check breakdown ({ name, status, reason, detail } objects)
    checks      jsonb not null default '[]'::jsonb,
    reasons     text[] not null default '{}',
    -- the path that requested the check, for attribution
    source      text,                                  -- 'sniper' | 'discretionary' | 'api'
    -- nullable: the public read-only API has no agent; sniper/discretionary do
    agent_id    text,
    user_id     text,
    -- the quote leg the verdict was computed against (lamports), for replay
    quote_lamports numeric(40, 0),
    enforced    boolean not null default true,         -- false when level=warn/off let it pass
    created_at  timestamptz not null default now()
);

-- Recent decisions for a mint (the API's brief cache + the learning loop).
create index if not exists firewall_decisions_mint
    on firewall_decisions (mint, network, created_at desc);

-- An agent's own firewall history (owner-facing audit + per-agent tuning).
create index if not exists firewall_decisions_agent
    on firewall_decisions (agent_id, created_at desc)
    where agent_id is not null;

-- Block-rate analytics across the platform.
create index if not exists firewall_decisions_verdict
    on firewall_decisions (verdict, created_at desc);

commit;

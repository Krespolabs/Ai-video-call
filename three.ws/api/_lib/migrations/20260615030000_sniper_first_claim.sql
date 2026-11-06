-- Migration: add the "first claim" trigger to the agent sniper.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260615030000_sniper_first_claim.sql
-- Idempotent.
--
-- The original sniper fires on the PumpPortal NEW-MINT feed (trigger = 'new_mint').
-- This adds a second trigger, 'first_claim': the sniper buys a creator's coin the
-- first time that creator EVER pulls their accrued creator/delegated rewards out
-- of the pump.fun fee vault — an irreversible, on-chain "the creator is live"
-- signal. The agent-sniper worker (workers/agent-sniper) polls scanFirstClaims,
-- scores each first claim against the new claim-specific filters below, waits the
-- owner-set delay, then snipes from the agent's own wallet through the SAME
-- executor / position-lifecycle path as a new-mint snipe.

begin;

alter table agent_sniper_strategies
    -- which signal arms this strategy. Existing rows keep new-mint behaviour.
    add column if not exists trigger text not null default 'new_mint'
        check (trigger in ('new_mint', 'first_claim')),
    -- how long to wait after the on-chain claim is observed before buying (ms).
    -- 0 = buy as fast as the queue allows; let snipers front-run or let the dust
    -- settle, the owner's call.
    add column if not exists buy_delay_ms int not null default 0
        check (buy_delay_ms >= 0 and buy_delay_ms <= 600000),
    -- only fire when the first claim pulled at least this many lamports — a floor
    -- that filters out dust claims and keeps the snipe to creators taking real fees.
    add column if not exists min_claim_lamports numeric(40, 0),
    -- optional upper bound (e.g. skip whales already cashing out hard).
    add column if not exists max_claim_lamports numeric(40, 0),
    -- ignore claims older than this many seconds when the worker first sees them,
    -- so a restart / backfill can't snipe a stale claim. null = the worker default.
    add column if not exists first_claim_max_age_seconds int
        check (first_claim_max_age_seconds is null or first_claim_max_age_seconds > 0);

-- The first-claim poll loop only wants armed first_claim strategies.
create index if not exists agent_sniper_strategies_first_claim
    on agent_sniper_strategies (enabled, kill_switch)
    where enabled = true and kill_switch = false and trigger = 'first_claim';

alter table agent_sniper_positions
    -- which trigger opened this position (provenance for the ledger / arena UI).
    add column if not exists entry_trigger text not null default 'new_mint'
        check (entry_trigger in ('new_mint', 'first_claim')),
    -- the on-chain reference that fired the entry: the claim tx signature for a
    -- first_claim snipe (null for new_mint — the mint address is the reference).
    add column if not exists trigger_ref text;

commit;

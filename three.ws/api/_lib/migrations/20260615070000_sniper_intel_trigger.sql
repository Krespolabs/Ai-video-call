-- Migration: add the "intel_confirmed" trigger + intel filters to the sniper.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260615070000_sniper_intel_trigger.sql
-- Idempotent.
--
-- The Coin Intelligence Engine (workers/agent-sniper/intel) finishes observing a
-- coin ~90s after launch and produces a quality score + bundle/organic/dev
-- signals. A new-mint snipe can't wait that long, so this adds a third trigger:
--
--   trigger = 'intel_confirmed' — the sniper buys AFTER the observation window,
--   only when the finished intel clears the owner's quality/bundle/concentration
--   gates. Slower than a raw snipe, dramatically safer: it trades confirmed
--   organic launches, not coin-flips. Routes through the SAME executor and
--   position-lifecycle path as the other triggers.

begin;

-- Extend the trigger enums. The inline column checks from the first_claim
-- migration are named <table>_<column>_check; drop and re-add with the new value.
alter table agent_sniper_strategies drop constraint if exists agent_sniper_strategies_trigger_check;
alter table agent_sniper_strategies
    add constraint agent_sniper_strategies_trigger_check
    check (trigger in ('new_mint', 'first_claim', 'intel_confirmed'));

alter table agent_sniper_positions drop constraint if exists agent_sniper_positions_entry_trigger_check;
alter table agent_sniper_positions
    add constraint agent_sniper_positions_entry_trigger_check
    check (entry_trigger in ('new_mint', 'first_claim', 'intel_confirmed'));

-- Intel gates (null = ignore). Applied to intel_confirmed strategies; also
-- available as bonus filters for the other triggers once intel exists for a mint.
alter table agent_sniper_strategies
    add column if not exists min_quality_score        int
        check (min_quality_score is null or (min_quality_score >= 0 and min_quality_score <= 100)),
    -- reject coins whose bundle likelihood exceeds this (0..1). Default-safe via app layer.
    add column if not exists max_bundle_score         numeric
        check (max_bundle_score is null or (max_bundle_score >= 0 and max_bundle_score <= 1)),
    -- reject coins where a single wallet captured more than this share of net buys (0..1).
    add column if not exists max_concentration_top1   numeric
        check (max_concentration_top1 is null or (max_concentration_top1 >= 0 and max_concentration_top1 <= 1)),
    -- skip coins where the dev sold inside the observation window.
    add column if not exists avoid_dev_dump           boolean not null default true,
    -- restrict to specific categories (meme/tech/ai/...). null/empty = any.
    add column if not exists allowed_categories       text[];

create index if not exists agent_sniper_strategies_intel
    on agent_sniper_strategies (enabled, kill_switch)
    where enabled = true and kill_switch = false and trigger = 'intel_confirmed';

commit;

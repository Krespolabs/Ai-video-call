-- Migration: add conditional_win_rates column to pump_intel_weights.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260616140000_intel_weights_conditional.sql
-- Idempotent (ADD COLUMN IF NOT EXISTS).
--
-- Stores per-signal bucket statistics: for each signal dimension (bundle_score,
-- smart_money_count, category, etc.) and each bucket (low/medium/high), records
-- the observed win-rate (% graduating or pumping) and sample count. Exposes the
-- "why" behind the Pearson weights so humans and agents can reason about it:
-- e.g. {"bundle_score": {"clean": {"win_rate": 0.23, "count": 312}, ...}}

begin;

alter table pump_intel_weights
    add column if not exists conditional_win_rates jsonb not null default '{}'::jsonb;

comment on column pump_intel_weights.conditional_win_rates is
    'Per-signal bucket win-rates: {signal: {bucket: {win_rate, count, baseline_win_rate}}}';

commit;

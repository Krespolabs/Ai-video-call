-- Migration: per-mint buyback full-swap + slippage config.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-05-20-pump-buyback-fullswap.sql
-- Idempotent.

begin;

-- ── pump_agent_mints: per-mint buyback config ───────────────────────────────
-- full_swap:    when true, the buyback cron CPIs a buy-on-curve before burn.
--               when false (default), the cron only burns whatever sits in
--               the burn-currency-mint vault — no swap.
-- slippage_bps: floor for `min_tokens_out` in the inner buy. 500 = 5%.
alter table pump_agent_mints
    add column if not exists full_swap    boolean not null default false,
    add column if not exists slippage_bps int     not null default 500
        check (slippage_bps between 0 and 10000);

commit;

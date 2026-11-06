-- Migration: record the quote (pairing) mint for each launched agent token.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260608000000_pump_quote_mint.sql
-- Idempotent.
--
-- Agent tokens can now be launched USDC-paired (pump.fun v2 stable pairs) so the
-- agent's USDC earnings → buyback → burn loop swaps in the same currency it
-- earns. `quote_mint` stores that pairing:
--   NULL  → SOL-paired (native SOL / wrapped SOL) — the historical default.
--   <mint>→ stable-paired; the quote SPL mint (e.g. the USDC mint).
-- The buyback cron still derives the live quote from the on-chain bonding curve,
-- so this column is for display, filtering, and analytics — existing rows stay
-- NULL (SOL-paired) and are unaffected.

begin;

alter table pump_agent_mints
	add column if not exists quote_mint text;

commit;

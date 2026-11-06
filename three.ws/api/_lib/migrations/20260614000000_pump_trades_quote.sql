-- Migration: quote-asset columns for pump_agent_trades.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260614000000_pump_trades_quote.sql
-- Idempotent.
--
-- The table modelled SOL only: `sol_amount` (lamports) and nothing recording
-- which quote asset a trade actually used. pump.fun v2 added USDC-paired coins
-- (buy_v2/sell_v2 with an explicit quote_mint), and our launch + curve code
-- supports them — but a USDC trade recorded against `sol_amount` is wrong by a
-- factor of ~200 (6-dec USDC atoms vs 9-dec lamports) and silently corrupts
-- prices, volumes, and portfolio subtotals for every USDC coin.
--
-- These columns make the row self-describing:
--   quote_mint    the quote SPL mint actually used (WSOL for SOL-paired, the
--                 USDC mint for stable-paired).
--   quote_symbol  'SOL' | 'USDC' | 'OTHER' — display + grouping label.
--   quote_amount  atomic units of the quote asset moved: spent on a buy,
--                 received on a sell (lamports for SOL, 1e6-USDC atoms).
--
-- `sol_amount` is kept (not dropped) for backward compatibility; new code reads
-- `quote_amount`. Every legacy row is SOL-paired, so backfill sets the SOL
-- defaults and copies sol_amount -> quote_amount.

begin;

alter table pump_agent_trades
	add column if not exists quote_mint text;
alter table pump_agent_trades
	add column if not exists quote_symbol text;
alter table pump_agent_trades
	add column if not exists quote_amount numeric(40, 0);

-- Backfill legacy rows as SOL-paired. Guarded on quote_mint is null so a re-run
-- never clobbers rows already written with their real quote asset.
update pump_agent_trades
set
	quote_mint = 'So11111111111111111111111111111111111111112',
	quote_symbol = 'SOL',
	quote_amount = sol_amount
where quote_mint is null;

commit;

-- Programmatic $THREE buyback ledger.
--
-- The run-three-buyback cron (api/cron/[name].js) converts accumulated platform
-- USDC revenue into onchain buy pressure: it market-buys $THREE on Jupiter and
-- routes the bought tokens into the treasury. This is the documented economy
-- policy ("the treasury funds buybacks … buy pressure without deflation",
-- api/_lib/token/config.js) made programmatic, onchain, and publicly auditable.
-- NO platform burn — supply is never destroyed by this lane.
--
-- One immutable row per run. Confirmed rows are the source of truth for the
-- public "revenue → $THREE bought back" figure on the $THREE token page. Skipped
-- and failed runs are recorded too (never a silent no-op), so an operator can see
-- exactly why a scheduled run did or didn't deploy capital.

begin;

create table if not exists three_buyback_runs (
  id                    uuid primary key default gen_random_uuid(),
  -- 'confirmed' | 'pending' | 'skipped' | 'failed' | 'dry_run'
  status                text not null,
  -- machine-readable skip/fail reason: 'disabled' | 'not_configured' | 'empty'
  -- | 'below_threshold' | 'no_quote' | 'price_unavailable' | 'swap_failed'
  -- | 'sweep_failed' | 'tx_unconfirmed'
  reason                text,
  -- Platform USDC fee revenue accrued to date at run time (atomics, 6dp). Context
  -- for the public ratio; the spend itself is driven by the wallet's USDC balance.
  revenue_fee_atomics   bigint not null default 0,
  -- USDC deployed into this buyback (atomics, 6dp).
  usdc_spent_atomics    bigint not null default 0,
  -- $THREE received from the swap (atomics).
  three_bought_atomics  bigint not null default 0,
  -- Effective execution price (USD per whole $THREE) derived from the fill.
  price_usd             numeric,
  slippage_bps          integer,
  -- Jupiter buy tx, and the treasury sweep tx (null when the buyback wallet IS the
  -- treasury, or when there was nothing to sweep).
  buy_signature         text,
  sweep_signature       text,
  treasury_wallet       text,
  error                 text,
  created_at            timestamptz not null default now()
);

create index if not exists three_buyback_runs_created
  on three_buyback_runs (created_at desc);

create index if not exists three_buyback_runs_status_created
  on three_buyback_runs (status, created_at desc);

commit;

-- Migration: $THREE Signal Feed time series.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260627120000_three_market_signals.sql
-- Idempotent.
--
-- Writers: api/cron/x402-autonomous-loop.js (registry entry `three-intel`, every
--          15 min) via api/_lib/x402/three-signal-store.js insertThreeSignal().
-- Readers: api/three-signal.js (public $THREE price widget feed),
--          $THREE-denominated x402 pricing (usdToThreeTokens uses latest price).

begin;

create table if not exists three_market_signals (
    id              bigserial primary key,
    ts              timestamptz not null default now(),
    mint            text,
    symbol          text,
    price_usd       double precision,
    change_24h      double precision,
    market_cap_usd  double precision,
    liquidity_usd   double precision,
    volume_24h_usd  double precision,
    signal          text,
    headline        text,
    confidence      double precision,
    run_id          uuid,
    source          text not null default 'x402-autonomous'
);

create index if not exists three_market_signals_ts_desc
    on three_market_signals (ts desc);

commit;
